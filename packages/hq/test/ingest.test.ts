import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { makeEnv, until } from './helpers.ts';
import { forApp } from '../src/api.ts';
import { isCancelled } from '../src/scheduler.ts';

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

const entry = (op: WalEntry['op'], args: Record<string, unknown>, id: string, identity = 'eli'): WalEntry =>
  ({ id, v: 1, ts: new Date().toISOString(), identity, shift: `${identity}-1`, sessionId: null, op, args });

async function ingestEnv() {
  const env = await makeEnv({ noStart: true, deps: { ticketer: async (repo, title) => `https://github.com/${repo}/issues/1#${encodeURIComponent(title)}` } });
  const mem = join(env.cfg.companyDir, '..', 'memory', 'projects', 'lumo');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'deploy.md'), '# פריסות של לומו\n\nה-rollout של server דורש kubectl rollout status לפני מיזוג.\n');
  await env.hq.start({ listen: true, timers: false });
  return { ...env, sock: join(env.cfg.stateDir, 'hq.sock') };
}

test('ingest socket: 0600, ops are idempotent on id, tell/ask/request_go land where they should', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    assert.equal(statSync(sock).mode & 0o777, 0o600);
    const t = await post(sock, '/v1/ops', entry('tell', { to: 'rotem', body: 'תבדקי את ה-API', urgency: 'now' }, 'eli-1:01'));
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, true);
    assert.equal(t.json.ref, 'eli-1:01');
    const m = hq.mailbox.get('eli-1:01')!;
    assert.equal(m.from_identity, 'eli');
    assert.equal(m.priority, 'now');
    assert.equal(m.urgency, 'urgent');
    const again = await post(sock, '/v1/ops', entry('tell', { to: 'rotem', body: 'תבדקי את ה-API', urgency: 'now' }, 'eli-1:01'));
    assert.deepEqual(again.json, t.json, 'replay → same ack');
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE id = 'eli-1:01'`).get() as { n: number }).n, 1);

    const a = await post(sock, '/v1/ops', entry('ask', { headline: 'חשבון החשמל', question: 'לשלם?', blocking: true, options: ['כן', 'לא'] }, 'eli-1:02'));
    assert.equal(hq.mailbox.getAsk(a.json.ref)!.blocking, true);
    assert.equal(hq.mailbox.getAsk(a.json.ref)!.headline, 'חשבון החשמל');
    assert.equal(hq.inbox.open().find((i) => i.kind === 'ask' && i.ref === 'eli-1:02')?.headline, 'חשבון החשמל');

    await post(sock, '/v1/ops', entry('request_go', { headline: 'עדכון לאפליקציה', what: 'פריסה לפרודקשן', pr: '#12', risk: 'high' }, 'ac-ceo-1:01', 'ac-ceo'));
    const go = hq.inbox.open().find((i) => i.kind === 'go')!;
    assert.equal(go.headline, 'עדכון לאפליקציה');
    assert.equal(go.urgency, 'urgent');
    assert.match(go.body, /PR: #12/);
    assert.deepEqual(go.links, [], 'a bare number with no repo behind it is not a link');
    await post(sock, '/v1/ops', entry('request_go', { headline: 'עוד אחד', what: 'פרטים', pr: 'https://github.com/hivecode-app/hive-code/pull/13', report: 'https://example.com/report' }, 'ac-ceo-1:02', 'ac-ceo'));
    assert.deepEqual(hq.inbox.open().find((i) => i.headline === 'עוד אחד')!.links,
      [{ kind: 'report', url: 'https://example.com/report' }, { kind: 'pr', url: 'https://github.com/hivecode-app/hive-code/pull/13' }]);
    await until(() => env.telegrams.some((x) => /GO: פריסה לפרודקשן/.test(x)), 2000, 'GO pushed (telegram fallback)');

    assert.equal((await post(sock, '/v1/ops', { ...entry('tell', {}, 'x'), v: 2 })).status, 400);
    assert.equal((await post(sock, '/v1/ops', entry('tell', { to: 'rotem' }, 'eli-1:03'))).status, 400, 'missing body = permanent reject');
    assert.equal((await post(sock, '/v1/ops', { ...entry('tell', {}, 'eli-1:04'), op: 'rm_rf' })).status, 400);
    assert.equal((await post(sock, '/v1/ops', entry('tell', { to: 'יואב', body: 'שם במקום id' }, 'eli-1:05'))).status, 400, 'unknown identity = permanent reject');
    assert.equal((await post(sock, '/v1/ops', entry('tell', { to: 'owner', body: 'לרן' }, 'eli-1:06'))).status, 200);
    await until(() => !!hq.mailbox.get('eli-1:05-rejected'), 2000, 'the sender hears its tell was rejected');
    assert.equal(hq.mailbox.get('eli-1:05-rejected')!.to_identity, 'eli');
    assert.match(hq.mailbox.get('eli-1:05-rejected')!.body, /^`tell` נדחה ב-hq: ההודעה ל-"יואב" לא נשלחה/);
    assert.match(hq.mailbox.get('eli-1:03-rejected')!.body, /^`tell` נדחה ב-hq: חסר השדה `body`/);
    assert.match(hq.mailbox.get('eli-1:04-rejected')!.body, /אין פעולה כזו/);
    assert.equal(hq.mailbox.get('x-rejected')!.to_identity, 'eli', 'a version mismatch from a known identity is reported too');
    assert.equal((await post(sock, '/v1/ops', entry('tell', { to: 'eli', body: 'שלום' }, 'dana-1:01', 'dana'))).status, 400);
    assert.ok(hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'op.rejected' AND json_extract(data, '$.from') = 'dana'`).get(),
      'an unknown sender has no mailbox, but the board sees the rejection');
    await post(sock, '/v1/ops', entry('tell', { to: 'hq', body: 'תודה' }, 'eli-1:07'));
    assert.equal(hq.mailbox.get('eli-1:07')!.state, 'handled', 'a reply to hq is closed, not delivered');
    assert.ok(!hq.shifts.current('hq'), 'no shift for hq');
    assert.equal(hq.store.db.prepare(`SELECT 1 FROM ops WHERE id = 'eli-1:03'`).get(), undefined, 'rejected ops are not stored');
  } finally { await env.cleanup(); }
});

test('handoff feeds prime.json of the next shift; open_ticket reports back; recall finds memory', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock, launcher } = env;
    await post(sock, '/v1/ops', entry('handoff', { state: 'תיקון ה-race מוזג', next: ['להסיר retry מהלקוח'], reason: 'rotation' }, 'eli-1:10'));
    hq.mailbox.tell({ msg_id: 'p-1', to: 'eli', body: 'המשך מאיפה שעצרת' });
    await until(() => launcher.launches.length === 1);
    const prime = JSON.parse(readFileSync(join(env.cfg.stateDir, 'shifts', 'eli-1', 'prime.json'), 'utf8'));
    assert.equal(prime.v, 1);
    assert.match(prime.handoff, /state: תיקון ה-race מוזג/);
    assert.match(prime.handoff, /- להסיר retry מהלקוח/);
    assert.match(prime.inbox, /p-1/);
    // topRecord: the body of the single most relevant memory record (bet 9).
    hq.mailbox.tell({ msg_id: 'p-2', to: 'rotem', body: 'בדקי rollout kubectl של לומו' });
    await until(() => launcher.launches.some((l) => l.identity === 'rotem'));
    const primeR = JSON.parse(readFileSync(join(env.cfg.stateDir, 'shifts', 'rotem-1', 'prime.json'), 'utf8'));
    assert.match(primeR.topRecord, /^\[memory\/projects\/lumo\/deploy\.md\]\n# פריסות של לומו/);
    const total = ['handoff', 'directives', 'topRecord', 'memoryIndex', 'inbox', 'pointers'].reduce((n, k) => n + (primeR[k]?.length ?? 0), 0);
    assert.ok(total <= 10_000);

    await post(sock, '/v1/ops', entry('open_ticket', { repo: 'hive-owner/lumo', title: 'תשלומים נכשלים', body: '...' }, 'eli-1:11'));
    await until(() => !!hq.mailbox.get('eli-1:11-ticket'), 2000, 'ticket reply');
    assert.match(hq.mailbox.get('eli-1:11-ticket')!.body, /github.com\/hive-owner\/lumo\/issues\/1/);

    const r = await post(sock, '/v1/recall', { identity: 'eli', shift: 'eli-1', query: 'rollout kubectl', scope: 'project:lumo' });
    assert.equal(r.status, 200);
    assert.equal(r.json.items[0].ref, 'memory/projects/lumo/deploy.md');
    const h = await post(sock, '/v1/recall', { identity: 'eli', shift: 'eli-1', query: 'race' });
    assert.ok(h.json.items.some((i: { ref: string }) => i.ref === 'eli-1:10'));
  } finally { await env.cleanup(); }
});

test('open_team priority: explicit field, p0/p1 from the title, explicit beats the title', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    const open = async (name: string, extra: Record<string, unknown>, id: string) => {
      const r = await post(sock, '/v1/ops', entry('open_team', { name, purpose: 'y', project: 'agent-company', ...extra }, id, 'yoav'));
      return { r, pr: r.status === 200 ? hq.scheduler.task(r.json.result.task as number)!.priority : undefined };
    };
    assert.equal((await open('משימה רגילה', {}, 'yoav-p:1')).pr, 2, 'default unchanged');
    assert.equal((await open('משימה דחופה', { priority: 1 }, 'yoav-p:2')).pr, 1, 'explicit field');
    assert.equal((await open('p0 תיקון פרצה', {}, 'yoav-p:3')).pr, 0);
    assert.equal((await open('P0: תיקון פרצה', {}, 'yoav-p:4')).pr, 0);
    assert.equal((await open('  [p0] תיקון', {}, 'yoav-p:5')).pr, 0);
    assert.equal((await open('(P1) תיקון', {}, 'yoav-p:6')).pr, 1);
    assert.equal((await open('p1: תיקון', {}, 'yoav-p:7')).pr, 1);
    assert.equal((await open('p2: תיקון', {}, 'yoav-p:8')).pr, 2, 'only p0 and p1 are read');
    assert.equal((await open('p05 משהו', {}, 'yoav-p:9')).pr, 2, 'p0 must stand alone');
    assert.equal((await open('p0: תיקון', { priority: 3 }, 'yoav-p:10')).pr, 3, 'explicit beats the title');
    assert.equal((await open('x', { priority: 4 }, 'yoav-p:11')).r.status, 400, 'out of range');
  } finally { await env.cleanup(); }
});

test('open_team opens a task: queued under the project, the worker hears the task from the opener', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock, launcher } = env;
    const r = await post(sock, '/v1/ops', entry('open_team', { name: 'תיקון typo ב-README', purpose: 'להחליף X ב-Y', project: 'agent-company', ref: 'hivecode-app/hive-code#3' }, 'yoav-1:01', 'yoav'));
    assert.equal(r.status, 200);
    const id = r.json.result.task as number;
    assert.equal(r.json.ref, `task-${id}`);
    const t = hq.scheduler.task(id)!;
    assert.equal(t.project, 'agent-company');
    assert.equal(t.ref, 'hivecode-app/hive-code#3');
    const again = await post(sock, '/v1/ops', entry('open_team', { name: 'תיקון typo ב-README', purpose: 'שוב', ref: 'hivecode-app/hive-code#3' }, 'yoav-1:02', 'yoav'));
    assert.equal(again.json.result.task, id, 'same ticket → same task');
    assert.ok(!JSON.parse(t.labels).includes('needs-local'), 'default: wherever there is room');
    const local = await post(sock, '/v1/ops', entry('open_team', { name: 'עם kubectl', purpose: 'y', project: 'agent-company', local: true }, 'yoav-1:01b', 'yoav'));
    assert.ok(JSON.parse(hq.scheduler.task(local.json.result.task as number)!.labels).includes('needs-local'), 'local: true stays here');
    const old = await post(sock, '/v1/ops', entry('open_team', { name: 'סכמה ישנה', purpose: 'y', project: 'agent-company', remote: true }, 'yoav-1:01c', 'yoav'));
    assert.deepEqual(JSON.parse(hq.scheduler.task(old.json.result.task as number)!.labels), ['opened-by:yoav'], 'remote (before 22/10) is ignored');
    assert.equal((await post(sock, '/v1/ops', entry('open_team', { name: 'x', purpose: 'y', project: 'my project' }, 'yoav-1:03', 'yoav'))).status, 400, 'bad slug = permanent reject');
    assert.equal((await post(sock, '/v1/ops', entry('open_team', { name: 'x', purpose: 'y', project: 'nope' }, 'yoav-1:04', 'yoav'))).status, 400, 'unknown project');
    writeFileSync(join(env.cfg.companyDir, 'projects', 'sleepy.md'), '---\nproject: sleepy\nstatus: dormant\n---\n');
    const dormant = await post(sock, '/v1/ops', entry('open_team', { name: 'x', purpose: 'y', project: 'sleepy' }, 'yoav-1:04b', 'yoav'));
    assert.equal(dormant.status, 400, 'a dormant project gets no team');
    assert.match(JSON.stringify(dormant.json), /dormant/);
    assert.match(dormant.json.reason, /רדום/, 'the Hebrew reason rides along for a synchronous caller');
    // #69: the WAL drops a 4xx silently, so the sender hears it in its mailbox and the board gets an event.
    const told = hq.mailbox.get('yoav-1:04b-rejected')!;
    assert.equal(told.to_identity, 'yoav');
    assert.equal(told.from_identity, 'hq');
    assert.equal(told.ref, 'yoav-1:04b');
    assert.match(told.body, /^`open_team` נדחה ב-hq: הפרויקט `sleepy` רדום/);
    assert.ok(hq.mailbox.get('yoav-1:04-rejected'), 'unknown project is reported too');
    await post(sock, '/v1/ops', entry('open_team', { name: 'x', purpose: 'y', project: 'sleepy' }, 'yoav-1:04b', 'yoav'));
    const rejectedEvents = (id: string) => (hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'op.rejected' AND json_extract(data, '$.id') = ?`)
      .get(id) as { n: number }).n;
    assert.equal(rejectedEvents('yoav-1:04b'), 1, 'a resend of the same rejected op is not reported twice');
    await hq.scheduler.fill();
    await until(() => launcher.launches.some((l) => l.identity === `agent-company-t${id}`), 2000, 'task worker launched');
    const first = hq.mailbox.list(`agent-company-t${id}`).find((m) => m.to_identity === `agent-company-t${id}`)!;
    assert.equal(first.from_identity, 'yoav', 'the opener sends the task, so the report comes back to him');
    assert.match(first.body, /תיקון typo ב-README/);
    assert.equal((hq.store.db.prepare('SELECT reports_to FROM identities WHERE id = ?').get(`agent-company-t${id}`) as { reports_to: string }).reports_to, 'yoav');
    await hq.scheduler.completeTask(id);
    const reopened = await post(sock, '/v1/ops', entry('open_team', { name: 'שוב', purpose: 'עוד פעם', ref: 'hivecode-app/hive-code#3' }, 'yoav-1:05', 'yoav'));
    assert.notEqual(reopened.json.result.task, id, 'a done task is not returned for the same ticket');
    const again2 = await post(sock, '/v1/ops', entry('open_team', { name: 'שוב', purpose: 'ושוב', ref: 'hivecode-app/hive-code#3' }, 'yoav-1:06', 'yoav'));
    assert.equal(again2.json.result.task, reopened.json.result.task, 'while the reopened task is open, the same ticket returns it');
  } finally { await env.cleanup(); }
});

test('close_team closes the task for real: reason first, shift stopped, task done, never woken again', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock, launcher, clock } = env;
    const r = await post(sock, '/v1/ops', entry('open_team', { name: 'משימה לסגירה', purpose: 'משהו', project: 'agent-company' }, 'eli-1:30'));
    const id = r.json.result.task as number;
    const worker = `agent-company-t${id}`;
    await hq.scheduler.fill();
    await until(() => hq.shifts.current(worker)?.state === 'live', 15_000, 'task worker live');

    // Not found / not allowed: 4xx with the reason, never `stored`, and the caller hears why.
    const missing = await post(sock, '/v1/ops', entry('close_team', { team: 't9999' }, 'eli-1:31'));
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /no team/);
    const foreign = await post(sock, '/v1/ops', entry('close_team', { team: `t${id}` }, 'rotem-1:01', 'rotem'));
    assert.equal(foreign.status, 403, 'rotem neither opened it nor manages its opener');
    await until(() => hq.mailbox.get('rotem-1:01-rejected')?.to_identity === 'rotem', 15_000, 'rejected caller is told');
    assert.equal(hq.scheduler.task(id)!.state, 'running');
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM ops WHERE op = 'close_team'`).get() as { n: number }).n, 0, 'a reject is not stored');

    // The opener closes it by the worker's identity.
    const ok = await post(sock, '/v1/ops', entry('close_team', { team: worker, reason: 'רן ביטל' }, 'eli-1:32'));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.task, id);
    await until(() => hq.scheduler.task(id)!.state === 'done', 15_000, 'task done');
    const shift = hq.shifts.get(`${worker}-1`)!;
    assert.notEqual(shift.state, 'live');
    assert.equal(shift.end_reason, 'task_done');
    const host = launcher.hosts.get(`${worker}-1`)!;
    const reasonAt = host.received.findIndex((f) => f.t === 'send' && /רן ביטל/.test(f.text));
    const stopAt = host.received.findIndex((f) => f.t === 'stop');
    assert.ok(reasonAt >= 0 && (stopAt < 0 || reasonAt < stopAt), 'the reason is sent to the worker before the stop');

    // Nothing brings it back: not the scheduler, not a message, not the delivery sweep.
    const workerLaunches = () => launcher.launches.filter((l) => l.identity === worker).length;
    const launches = workerLaunches();
    await hq.scheduler.sweep();
    hq.mailbox.tell({ msg_id: 'late-1', from: 'eli', to: worker, body: 'עוד משהו?' });
    await until(() => hq.mailbox.get('late-1')!.state === 'failed', 15_000, 'message to a closed task fails');
    assert.match(hq.mailbox.get('late-1')!.error ?? '', /המשימה כבר נסגרה/);
    assert.match(hq.mailbox.get('late-1-failed')!.body, /המשימה כבר נסגרה/, 'the sender hears it is closed');
    clock.advance(hq.cfg.timers.deliveryTimeoutMs * 3);
    await hq.mailbox.sweep();
    await hq.scheduler.sweep();
    assert.equal(workerLaunches(), launches, 'no new shift for a closed task');
    assert.equal(hq.shifts.current(worker), undefined);

    // Closing again is a no-op ack; the manager of the opener (yoav) may close too.
    const again = await post(sock, '/v1/ops', entry('close_team', { team: `task-${id}` }, 'yoav-1:30', 'yoav'));
    assert.equal(again.status, 200);
    assert.equal(again.json.result.already, true);
  } finally { await env.cleanup(); }
});

test('delivery sweep never resurrects a worker whose task closed while its shift was up', async () => {
  const env = await ingestEnv();
  try {
    const { hq, launcher, clock } = env;
    const t = hq.scheduler.addTask({ title: 'תקוע', project: 'agent-company', labels: ['opened-by:eli'] });
    const worker = `agent-company-t${t.id}`;
    await hq.scheduler.fill();
    await until(() => hq.shifts.current(worker)?.state === 'live', 3000, 'task worker live');
    // A message stuck in a live shift, and the task closes underneath (the race close_team ↔ sweep).
    hq.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, urgency, priority, state, attempts, last_attempt_at, created_at)
      VALUES ('stuck-1', 'eli', ?, 'tell', 'תקוע?', 'normal', 'next', 'queued', 1, ?, ?)`).run(worker, clock.now(), clock.now());
    hq.scheduler.setTaskState(t.id, 'done');
    const before = launcher.launches.filter((l) => l.identity === worker).length;
    clock.advance(hq.cfg.timers.deliveryTimeoutMs * 2);
    await hq.mailbox.sweep();
    await until(() => !hq.shifts.current(worker), 3000, 'the closed worker\'s shift stops');
    assert.equal(launcher.launches.filter((l) => l.identity === worker).length, before, 'no resurrect for a closed task');
    assert.equal(hq.mailbox.get('stuck-1')!.state, 'failed');
    assert.match(hq.mailbox.get('stuck-1-failed')!.body, /המשימה כבר נסגרה/);
  } finally { await env.cleanup(); }
});

test('sweep and completeTask racing: the closed task stays done and no shift comes back', async () => {
  const env = await ingestEnv();
  try {
    const { hq, launcher, clock } = env;
    const t = hq.scheduler.addTask({ title: 'מרוץ', project: 'agent-company', labels: ['opened-by:eli'] });
    const worker = `agent-company-t${t.id}`;
    await hq.scheduler.fill();
    await until(() => hq.shifts.current(worker)?.state === 'live', 3000, 'task worker live');
    hq.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, urgency, priority, state, attempts, last_attempt_at, created_at)
      VALUES ('race-1', 'eli', ?, 'tell', 'תקוע?', 'normal', 'next', 'queued', 1, ?, ?)`).run(worker, clock.now(), clock.now());
    clock.advance(hq.cfg.timers.deliveryTimeoutMs * 2);
    const before = launcher.launches.filter((l) => l.identity === worker).length;
    await Promise.all([hq.mailbox.sweep(), hq.scheduler.completeTask(t.id)]);
    await hq.scheduler.fill();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hq.scheduler.task(t.id)!.state, 'done');
    assert.equal(hq.shifts.current(worker), undefined, 'no live shift for the closed task');
    assert.equal(launcher.launches.filter((l) => l.identity === worker).length, before, 'never relaunched');
  } finally { await env.cleanup(); }
});

test('his words and his answer on a GO of a closed worker reach whoever opened its task, never a delivery failure (21/10)', async () => {
  const env = await ingestEnv();
  try {
    const { hq, clock } = env;
    const t = hq.scheduler.addTask({ title: 'נסגרה', project: 'agent-company', labels: ['opened-by:eli'] });
    const worker = `agent-company-t${t.id}`;
    hq.store.db.prepare(`INSERT INTO identities (id, name, team_kind, project, reports_to, lifecycle, source, updated_at)
      VALUES (?, 'אביב', 'task', 'agent-company', 'eli', 'ephemeral', 'runtime', 0)`).run(worker);
    hq.store.db.prepare('UPDATE tasks SET identity = ? WHERE id = ?').run(worker, t.id);
    hq.scheduler.setTaskState(t.id, 'done');
    const failures = () => hq.inbox.open().filter((i) => i.kind === 'delivery_failure');

    // He writes to the closed worker: it is passed to the opener, with why, and he gets no failure card.
    hq.mailbox.tell({ msg_id: 'o-1', to: worker, body: 'עוד משהו?' });
    await until(() => hq.mailbox.get('o-1')!.state === 'failed', 2000, 'message to a closed task fails');
    const fwd = hq.mailbox.get('o-1-fwd')!;
    assert.equal(fwd.to_identity, 'eli');
    assert.equal(fwd.from_identity, 'owner');
    assert.match(fwd.body, /עוד משהו\?/);
    assert.match(fwd.body, /נסגר/);
    assert.equal(failures().length, 0);

    // A GO from that worker: his "אישור" goes to the opener, with the context.
    const go = hq.inbox.add({ kind: 'go', title: 'פריסה', from_identity: worker, urgency: 'normal' });
    const done = hq.mailbox.complete(go.id).message!;
    assert.equal(done.to_identity, 'eli');
    assert.match(done.body, /כבר סיים ונסגר/);
    const fed = hq.store.db.prepare(`SELECT data FROM events WHERE type = 'inbox.completed'`).all() as { data: string }[];
    assert.ok(fed.some((r) => JSON.parse(r.data).id === go.id), 'the approved GO still reaches the feed');

    // The system's own "סיימתי" lost on a closed task is not a new item for him.
    hq.mailbox.tell({ msg_id: 'inbox-900-done', from: 'owner', to: worker, kind: 'answer', body: 'רן סיים: x' });
    await until(() => hq.mailbox.get('inbox-900-done')!.state === 'failed', 2000, 'fails on the closed task');
    hq.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, urgency, priority, state, attempts, resurrected, last_attempt_at, created_at)
      VALUES ('inbox-901-done', 'owner', 'amit', 'answer', 'רן סיים: y', 'normal', 'now', 'queued', 2, 1, ?, ?)`).run(clock.now(), clock.now());
    clock.advance(hq.cfg.timers.deliveryTimeoutMs * 2);
    await hq.mailbox.sweep();
    assert.equal(hq.mailbox.get('inbox-901-done')!.state, 'failed');
    assert.equal(failures().length, 0);

    // Nobody to pass it to (the opener and the manager are gone): the old failure card, once; closing it is quiet.
    hq.store.db.prepare('UPDATE tasks SET labels = ?, project = NULL WHERE id = ?').run('[]', t.id);
    hq.store.db.prepare(`UPDATE identities SET active = 0 WHERE id IN ('eli', ?)`).run(hq.cfg.managerId);
    hq.mailbox.tell({ msg_id: 'o-2', to: worker, body: 'ולזה?' });
    await until(() => failures().length === 1, 2000, 'no one to pass it to: a delivery failure');
    hq.mailbox.complete(failures()[0]!.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(failures().length, 0);
  } finally { await env.cleanup(); }
});

test('close_team by display name; an ambiguous name is rejected', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    const a = hq.scheduler.addTask({ title: 'א', project: 'agent-company', labels: ['opened-by:eli'] });
    hq.store.db.prepare(`INSERT INTO identities (id, name, team_kind, project, reports_to, lifecycle, source, updated_at)
      VALUES (?, 'דנה', 'task', 'agent-company', 'eli', 'ephemeral', 'runtime', 0)`).run(`agent-company-t${a.id}`);
    hq.store.db.prepare('UPDATE tasks SET identity = ? WHERE id = ?').run(`agent-company-t${a.id}`, a.id);
    const r = await post(sock, '/v1/ops', entry('close_team', { team: 'דנה' }, 'eli-1:40'));
    assert.equal(r.status, 200);
    assert.equal(r.json.result.task, a.id);
    await until(() => hq.scheduler.task(a.id)!.state === 'done', 2000, 'closed by name');
    const b = hq.scheduler.addTask({ title: 'ב', project: 'agent-company', labels: ['opened-by:eli'] });
    const c = hq.scheduler.addTask({ title: 'ג', project: 'agent-company', labels: ['opened-by:eli'] });
    for (const t of [b, c]) {
      hq.store.db.prepare(`INSERT INTO identities (id, name, team_kind, project, reports_to, lifecycle, source, updated_at)
        VALUES (?, 'עומר', 'task', 'agent-company', 'eli', 'ephemeral', 'runtime', 0)`).run(`agent-company-t${t.id}`);
      hq.store.db.prepare('UPDATE tasks SET identity = ? WHERE id = ?').run(`agent-company-t${t.id}`, t.id);
    }
    assert.equal((await post(sock, '/v1/ops', entry('close_team', { team: 'עומר' }, 'eli-1:41'))).status, 409);
  } finally { await env.cleanup(); }
});

test('ingest over TCP requires the token', async () => {
  const env = await ingestEnv();
  try {
    const res = await fetch(`http://127.0.0.1:${env.hq.port}/v1/ops`, { method: 'POST', body: JSON.stringify(entry('status', { state: 'idle' }, 'eli-1:20')) });
    assert.equal(res.status, 401);
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const ok = await fetch(`http://127.0.0.1:${env.hq.port}/v1/ops`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(entry('status', { state: 'idle' }, 'eli-1:20')) });
    assert.equal(ok.status, 200);
  } finally { await env.cleanup(); }
});

test('delivery states from the host: delivered → started = seen; deltas stream live-only', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    const live: { type: string; seq: number }[] = [];
    hq.store.onEvent((e) => live.push(e));
    hq.mailbox.tell({ msg_id: 'd-1', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('d-1')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('d-1', 'started');
    await until(() => hq.mailbox.get('d-1')!.state === 'seen', 2000, 'started → seen');
    host.live({ t: 'delta', ev: { kind: 'text_delta', text: 'של' } });
    await until(() => live.some((e) => e.type === 'engine.delta'), 2000, 'delta published');
    assert.equal(live.find((e) => e.type === 'engine.delta')!.seq, 0);
    assert.equal(hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'engine.delta'`).get(), undefined, 'not persisted');

    // Re-send after an hq crash is idempotent in the host: the reply's state is applied.
    hq.store.db.prepare(`UPDATE messages SET state = 'queued' WHERE id = 'd-1'`).run();
    await hq.mailbox.deliver('d-1');
    assert.equal(hq.mailbox.get('d-1')!.state, 'seen', 'host reports it as already started');
    assert.equal(host.sent.filter((x) => x.msgId === 'd-1').length, 1, 'nothing written twice');
  } finally { await env.cleanup(); }
});

test('#53: a task\'s summary comes from status done, and close_team\'s overrides it; one line, no blanks', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    const r = await post(sock, '/v1/ops', entry('open_team', { name: 'אפליקציה: תמונות', purpose: 'משהו', project: 'agent-company' }, 'eli-1:50'));
    const id = r.json.result.task as number;
    const worker = `agent-company-t${id}`;
    await hq.scheduler.fill();
    await until(() => hq.shifts.current(worker)?.state === 'live', 3000, 'task worker live');
    // needs-local from a worker here (not on a node): nothing moves, the task keeps running (task-235).
    const stay = await post(sock, '/v1/ops', entry('status', { state: 'needs-local', note: 'kubectl' }, `${worker}-1:00`, worker));
    assert.equal(stay.json.result.moving, null);
    assert.equal(hq.scheduler.task(id)!.state, 'running');
    const done = await post(sock, '/v1/ops', entry('status', { state: 'done', summary: '  התמונות עלו\nPR #12 מוזג' }, `${worker}-1:01`, worker));
    assert.equal(done.status, 200);
    await until(() => hq.scheduler.task(id)!.state === 'done', 3000, 'task done');
    assert.equal(hq.scheduler.task(id)!.summary, 'התמונות עלו', 'the first line, trimmed');
    assert.equal((hq.scheduler.tasks().find((t) => t.id === id) as { summary?: string }).summary, 'התמונות עלו', 'the board carries it');
    await post(sock, '/v1/ops', entry('close_team', { team: `t${id}`, summary: 'התמונות בצ\'אט עולות גם מהטלפון' }, 'eli-1:51'));
    assert.equal(hq.scheduler.task(id)!.summary, 'התמונות בצ\'אט עולות גם מהטלפון', 'the closer has the last word');
    await post(sock, '/v1/ops', entry('close_team', { team: `t${id}`, summary: '   ' }, 'eli-1:52'));
    assert.equal(hq.scheduler.task(id)!.summary, 'התמונות בצ\'אט עולות גם מהטלפון', 'a blank one changes nothing');
  } finally { await env.cleanup(); }
});

test('#108: status done marks what the task still waits for; close_team overrides it, also after the fact', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    const r = await post(sock, '/v1/ops', entry('open_team', { name: 'אפליקציה: תמונות', purpose: 'משהו', project: 'agent-company' }, 'eli-1:60'));
    const id = r.json.result.task as number;
    const worker = `agent-company-t${id}`;
    await hq.scheduler.fill();
    await until(() => hq.shifts.current(worker)?.state === 'live', 3000, 'task worker live');
    await post(sock, '/v1/ops', entry('status', { state: 'done', summary: 'התמונות עולות', awaiting: 'deploy',
      awaiting_note: 'מחכה ל-GO\nשורה שנייה', pr: 'https://github.com/hivecode-app/hive-code/pull/77' }, `${worker}-1:01`, worker));
    await until(() => hq.scheduler.task(id)!.state === 'done', 3000, 'task done');
    let t = hq.scheduler.task(id)!;
    assert.equal(t.awaiting, 'deploy');
    assert.equal(t.awaiting_note, 'מחכה ל-GO', 'one line');
    assert.equal(t.pr, '77', 'the number, from the url');
    assert.deepEqual(hq.awaiting.list().map((x) => x.id), [id]);

    await post(sock, '/v1/ops', entry('close_team', { team: `t${id}`, awaiting: 'check', awaiting_note: 'לשלוח תמונה מהטלפון' }, 'eli-1:61'));
    t = hq.scheduler.task(id)!;
    assert.equal(t.awaiting, 'check', 'the closer has the last word, on a task already done');
    assert.equal(t.awaiting_note, 'לשלוח תמונה מהטלפון');

    await post(sock, '/v1/ops', entry('close_team', { team: `t${id}`, awaiting: 'later' }, 'eli-1:62'));
    assert.equal(hq.scheduler.task(id)!.awaiting, 'check', 'an unknown value changes nothing');
    await post(sock, '/v1/ops', entry('close_team', { team: `t${id}`, awaiting: 'none' }, 'eli-1:63'));
    assert.equal(hq.scheduler.task(id)!.awaiting, null);
    assert.equal(hq.awaiting.list().length, 0);
  } finally { await env.cleanup(); }
});

test('a task with an open GO is not closed: status done waits, close_team is refused; with force the GO and its answer go to the opener (21/10)', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    const r = await post(sock, '/v1/ops', entry('open_team', { name: 'אפליקציה: קורא מסך', purpose: 'משהו', project: 'agent-company' }, 'eli-1:60'));
    const id = r.json.result.task as number;
    const worker = `agent-company-t${id}`;
    await hq.scheduler.fill();
    await until(() => hq.shifts.current(worker)?.state === 'live', 3000, 'task worker live');
    await post(sock, '/v1/ops', entry('request_go', { what: 'לפרוס את הקורא מסך', headline: 'קורא מסך' }, `${worker}-1:01`, worker));
    const go = hq.inbox.open().find((i) => i.kind === 'go' && i.from_identity === worker)!;

    await post(sock, '/v1/ops', entry('status', { state: 'done', summary: 'x' }, `${worker}-1:02`, worker));
    await until(() => !!hq.mailbox.get(`${worker}-1:02-go-open`), 3000, 'the worker hears why the task stays');
    assert.match(hq.mailbox.get(`${worker}-1:02-go-open`)!.body, /קורא מסך/);
    assert.equal(hq.scheduler.task(id)!.state, 'running');

    const refused = await post(sock, '/v1/ops', entry('close_team', { team: `t${id}` }, 'eli-1:61'));
    assert.notEqual(refused.json.result?.state, 'closing');
    assert.equal(hq.scheduler.task(id)!.state, 'running');

    await post(sock, '/v1/ops', entry('close_team', { team: `t${id}`, force: true }, 'eli-1:62'));
    await until(() => hq.scheduler.task(id)!.state === 'done', 3000, 'closed with force');
    await until(() => !!hq.mailbox.get(`task-${id}-go-handover`), 3000, 'handover');
    const handover = hq.mailbox.get(`task-${id}-go-handover`)!;
    assert.equal(handover.to_identity, 'eli');
    assert.match(handover.body, /קורא מסך/);

    const answer = hq.mailbox.reply(go.id, 'כן');
    assert.equal(answer.message!.to_identity, 'eli', 'his answer is not lost on the closed worker');
    assert.equal(hq.inbox.get(go.id)!.state, 'resolved');
  } finally { await env.cleanup(); }
});

test('status done from a standing worker with no task rests its shift now; a message wakes it; the manager stays', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    hq.store.setToggle('scheduler', false);
    await hq.scheduler.ensureResidents();
    hq.mailbox.tell({ msg_id: 'rd-1', to: 'eli', body: 'שלום' });
    await until(() => hq.mailbox.get('rd-1')!.state === 'delivered', 5000, 'eli up');
    hq.mailbox.markHandled('rd-1');
    await until(() => !hq.shifts.get('eli-1')!.in_turn, 5000, 'eli idle');
    const r = await post(sock, '/v1/ops', entry('status', { state: 'done', summary: 'סיימתי' }, 'eli-1:60'));
    assert.equal(r.json.result.task_done, null);
    await until(() => hq.shifts.get('eli-1')!.state === 'ended', 5000, 'eli rested');
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');

    // The manager is a resident: done does not rest it.
    await post(sock, '/v1/ops', entry('status', { state: 'done' }, 'yoav-1:60', 'yoav'));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(hq.shifts.get('yoav-1')!.state, 'live');

    // Mail on the way: it stays up (the message is its work).
    hq.mailbox.tell({ msg_id: 'rd-2', to: 'ac-ceo', body: 'שלום' });
    await until(() => hq.mailbox.get('rd-2')!.state === 'delivered', 5000, 'ac-ceo up');
    hq.mailbox.markHandled('rd-2');
    await until(() => !hq.shifts.get('ac-ceo-1')!.in_turn, 5000, 'ac-ceo idle');
    hq.mailbox.tell({ msg_id: 'rd-3', to: 'ac-ceo', body: 'עוד משהו' });
    await post(sock, '/v1/ops', entry('status', { state: 'done' }, 'ac-ceo-1:60', 'ac-ceo'));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(hq.shifts.get('ac-ceo-1')!.state, 'live');
  } finally { await env.cleanup(); }
});

test('restIdle does not cut a turn that started while it waited', async () => {
  const env = await ingestEnv();
  try {
    const { hq } = env;
    hq.store.setToggle('scheduler', false);
    await hq.scheduler.ensureResidents();
    hq.mailbox.tell({ msg_id: 'ri-1', to: 'eli', body: 'שלום' });
    await until(() => hq.mailbox.get('ri-1')!.state === 'delivered', 5000, 'eli up');
    hq.mailbox.markHandled('ri-1');
    await until(() => !hq.shifts.get('eli-1')!.in_turn, 5000, 'eli idle');
    // A message arrives during the wait and the worker starts answering it.
    const wait = hq.shifts.waitTurnEnd.bind(hq.shifts);
    hq.shifts.waitTurnEnd = async (...a: Parameters<typeof wait>) => {
      await wait(...a);
      hq.store.db.prepare('UPDATE shifts SET in_turn = 1 WHERE id = ?').run('eli-1');
    };
    assert.equal(await hq.scheduler.restIdle('eli'), false);
    assert.equal(hq.shifts.get('eli-1')!.state, 'live');
  } finally { await env.cleanup(); }
});

test('close_team on a task that never started marks it cancelled; one that ran is finished', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    hq.store.setToggle('scheduler', false);
    const waiting = hq.scheduler.addTask({ title: 'לא התחילה', project: 'agent-company', labels: ['opened-by:eli'] });
    assert.equal(waiting.started_at, null);
    const r = await post(sock, '/v1/ops', entry('close_team', { team: `t${waiting.id}`, reason: 'הועברה לעובד אחר' }, 'eli-1:61'));
    assert.equal(r.status, 200);
    await until(() => hq.scheduler.task(waiting.id)!.state === 'done', 3000, 'closed');
    const row = hq.scheduler.task(waiting.id)!;
    assert.ok(isCancelled(row));
    assert.deepEqual(forApp([row]).map((t) => t.state), ['closed'], 'the app hides it instead of showing it finished');
    assert.ok(!hq.openTasks().some((t) => t.id === waiting.id));

    const ran = hq.scheduler.addTask({ title: 'רצה', project: 'agent-company', labels: ['opened-by:eli'] });
    hq.store.db.prepare(`UPDATE tasks SET started_at = ?, state = 'running' WHERE id = ?`).run(hq.store.now(), ran.id);
    await post(sock, '/v1/ops', entry('close_team', { team: `t${ran.id}` }, 'eli-1:62'));
    await until(() => hq.scheduler.task(ran.id)!.state === 'done', 3000, 'closed');
    const done = hq.scheduler.task(ran.id)!;
    assert.ok(!isCancelled(done));
    assert.deepEqual(forApp([done]).map((t) => t.state), ['done']);
  } finally { await env.cleanup(); }
});

test('close_team on a task that ran and went back to the queue is finished, not cancelled', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    hq.store.setToggle('scheduler', false);
    const t = hq.scheduler.addTask({ title: 'עבדה והוחזרה', project: 'agent-company', labels: ['opened-by:eli'] });
    // It ran (task.state running), then was moved between machines: back in the queue with started_at cleared.
    hq.store.emit('task.state', 'eli', { id: t.id, state: 'running' });
    assert.equal(hq.scheduler.task(t.id)!.started_at, null);
    await post(sock, '/v1/ops', entry('close_team', { team: `t${t.id}` }, 'eli-1:63'));
    await until(() => hq.scheduler.task(t.id)!.state === 'done', 3000, 'closed');
    assert.ok(!isCancelled(hq.scheduler.task(t.id)!));
  } finally { await env.cleanup(); }
});
