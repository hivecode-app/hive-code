// Codex as a task worker (task 836, docs/spec/codex-helper.md): only a task its opener sends to Codex, in a project
// whose charter allows it, runs on Codex. Out of quota, the opener hears it and nothing moves to Claude by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { makeEnv, until } from './helpers.ts';
import { appServerLimits, CodexQuota, codexOf, parseLimits, type CodexLimits } from '../src/codex-quota.ts';

const ON = '---\nproject: agent-company\nstatus: active\ncodex:\n  tasks: on-request\n  model: gpt-6-astra\n---\n';
const OFF = '---\nproject: agent-company\nstatus: active\n---\n';

function post(socketPath: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request({ socketPath, path: '/v1/ops', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const open = (args: Record<string, unknown>, id: string): WalEntry =>
  ({ id, v: 1, ts: new Date().toISOString(), identity: 'yoav', shift: 'yoav-1', sessionId: null, op: 'open_team', args });

/** A reader that answers whatever the test sets. */
function limits(start: CodexLimits | Error) {
  let v: CodexLimits | Error = start;
  return { set: (x: CodexLimits | Error) => { v = x; }, read: async () => { if (v instanceof Error) throw v; return v; } };
}

async function env(charter: string, used = 3) {
  const l = limits({ usedPercent: used, resetsAt: Date.UTC(2026, 10, 3, 21, 51), plan: 'prolite' });
  const e = await makeEnv({ noStart: true, projects: { 'agent-company': charter }, deps: { codexLimits: l.read } });
  await e.hq.start({ listen: true, timers: false });
  await e.hq.codexQuota.refresh();
  return { ...e, limits: l, sock: join(e.cfg.stateDir, 'hq.sock') };
}

test('open_team engine codex: only where the charter allows it, without an assignee, and under the quota guard', async () => {
  const off = await env(OFF);
  try {
    const r = await post(off.sock, open({ name: 'בדיקות ל-parser', purpose: 'y', project: 'agent-company', engine: 'codex' }, 'yoav-c:0'));
    assert.equal(r.status, 400);
    assert.match(r.json.reason, /Codex לא דולק בפרויקט/);
    const claude = await post(off.sock, open({ name: 'רגילה', purpose: 'y', project: 'agent-company' }, 'yoav-c:00'));
    assert.equal(codexOf(off.hq.scheduler.task(claude.json.result.task)!.labels), null, 'Claude stays the default');
  } finally { await off.cleanup(); }

  const e = await env(ON);
  try {
    const r = await post(e.sock, open({ name: 'בדיקות ל-parser', purpose: 'y', project: 'agent-company', engine: 'codex' }, 'yoav-c:1'));
    assert.equal(r.status, 200);
    const t = e.hq.scheduler.task(r.json.result.task)!;
    assert.deepEqual(codexOf(t.labels), { model: 'gpt-6-astra' }, 'the charter\'s model');
    const m = await post(e.sock, open({ name: 'עוד', purpose: 'y', project: 'agent-company', engine: 'codex', model: 'gpt-5.6-sol' }, 'yoav-c:2'));
    assert.deepEqual(codexOf(e.hq.scheduler.task(m.json.result.task)!.labels), { model: 'gpt-5.6-sol' });
    assert.equal((await post(e.sock, open({ name: 'x', purpose: 'y', project: 'agent-company', engine: 'gemini' }, 'yoav-c:3'))).status, 400);
    const assigned = await post(e.sock, open({ name: 'x', purpose: 'y', project: 'agent-company', engine: 'codex', assignee: 'ac-ceo' }, 'yoav-c:4'));
    assert.equal(assigned.status, 400);
    assert.match(assigned.json.reason, /בלי `assignee`/);

    e.limits.set({ usedPercent: 25, resetsAt: Date.UTC(2026, 10, 3, 21, 51), plan: 'prolite' });
    await e.hq.codexQuota.refresh();
    const over = await post(e.sock, open({ name: 'x', purpose: 'y', project: 'agent-company', engine: 'codex' }, 'yoav-c:5'));
    assert.equal(over.status, 409);
    assert.match(over.json.reason, /עד 20% מהשבוע/);
    assert.match(over.json.reason, /לא עוברת ל-Claude לבד/);
    e.limits.set({ usedPercent: 100, resetsAt: Date.UTC(2026, 10, 3, 21, 51), plan: 'prolite' });
    await e.hq.codexQuota.refresh();
    assert.match((await post(e.sock, open({ name: 'x', purpose: 'y', project: 'agent-company', engine: 'codex' }, 'yoav-c:6'))).json.reason, /נגמרה/);
  } finally { await e.cleanup(); }
});

test('a Codex task launches on Codex in task mode, here; a Claude task next to it does not', async () => {
  const e = await env(ON);
  try {
    const { hq, launcher } = e;
    const cx = hq.scheduler.addTask({ title: 'משימת Codex', body: 'b', project: 'agent-company', labels: ['opened-by:yoav', 'engine:codex', 'codex-model:gpt-6-astra'] });
    const cl = hq.scheduler.addTask({ title: 'משימת Claude', body: 'b', project: 'agent-company', labels: ['opened-by:yoav'] });
    await hq.scheduler.fill();
    await until(() => launcher.launches.length === 2);
    const codex = launcher.launches.find((l) => l.taskId === cx.id)!;
    assert.equal(codex.provider, 'codex');
    assert.equal(codex.codexMode, 'task');
    assert.equal(codex.codexModel, 'gpt-6-astra');
    assert.equal(codex.account, 'codex');
    const claude = launcher.launches.find((l) => l.taskId === cl.id)!;
    assert.equal(claude.provider, undefined);
    assert.notEqual(claude.account, 'codex');
    assert.ok(hq.store.db.prepare('SELECT name FROM identities WHERE id = ?').get(`agent-company-t${cx.id}`));
  } finally { await e.cleanup(); }
});

test('the quota ran out before the start: out of the queue, the opener hears it, nothing starts on Claude', async () => {
  const e = await env(ON);
  try {
    const { hq, launcher } = e;
    e.limits.set({ usedPercent: 100, resetsAt: null, plan: 'prolite' });
    await hq.codexQuota.refresh();
    const t = hq.scheduler.addTask({ title: 'משימת Codex', body: 'b', project: 'agent-company', labels: ['opened-by:yoav', 'engine:codex'] });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.filter((l) => l.taskId === t.id || l.identity === `agent-company-t${t.id}`).length, 0);
    assert.ok(JSON.parse(hq.scheduler.task(t.id)!.labels).includes('needs-decision'));
    const told = hq.store.db.prepare(`SELECT body, to_identity FROM messages WHERE id LIKE ?`).get(`task-${t.id}-codex-quota-%`) as { body: string; to_identity: string };
    assert.equal(told.to_identity, 'yoav');
    assert.match(told.body, /לא עברה ל-Claude/);
  } finally { await e.cleanup(); }
});

test('out of quota mid-task: the opener hears it once, the task stays on Codex', async () => {
  const e = await env(ON);
  try {
    const { hq, launcher } = e;
    const t = hq.scheduler.addTask({ title: 'משימת Codex', body: 'b', project: 'agent-company', labels: ['opened-by:yoav', 'engine:codex'] });
    await hq.scheduler.fill();
    await until(() => launcher.launches.length === 1);
    const shift = hq.shifts.current(`agent-company-t${t.id}`)!;
    await until(() => hq.shifts.get(shift.id)?.state === 'live');
    const host = launcher.hosts.get(shift.id)!;
    // A fresh shift of the task worker, with no task id on it (woken by a message after a stuck restart).
    hq.shifts.setFields(shift.id, { task_id: null });
    host.event({ kind: 'result', subtype: 'error_during_execution', isError: true, text: 'line 429 failed: quota field missing' });
    host.event({ kind: 'result', subtype: 'error_during_execution', isError: true, text: "You've hit your usage limit. Try again in 3 days." });
    host.event({ kind: 'result', subtype: 'error_during_execution', isError: true, text: "You've hit your usage limit. Try again in 3 days." });
    const id = `task-${t.id}-codex-limit-${Date.UTC(2026, 10, 3, 21, 51)}`;
    await until(() => !!hq.mailbox.get(id));
    await new Promise((r) => setTimeout(r, 100));
    const m = hq.mailbox.get(id)!;
    assert.equal(m.to_identity, 'yoav');
    assert.match(m.body, /מכסת Codex נגמרה\. היא לא עברה ל-Claude/);
    assert.doesNotMatch(m.body, /usage limit/, 'his message, not Codex\'s raw error');
    assert.equal((hq.store.db.prepare(`SELECT count(*) n FROM events WHERE type = 'codex.limit'`).get() as { n: number }).n, 1, 'one event, not one per turn');
    assert.equal((hq.store.db.prepare(`SELECT count(*) n FROM messages WHERE id LIKE ?`).get(`task-${t.id}-codex-limit%`) as { n: number }).n, 1);
    // (yoav's own shift wakes for the message; the task's worker gets no Claude shift.)
    assert.deepEqual(launcher.launches.filter((l) => l.identity === `agent-company-t${t.id}`).map((l) => l.provider), ['codex'], 'no Claude shift instead');
  } finally { await e.cleanup(); }
});

test('the home shows Codex\'s week after the accounts; a failed read keeps the last numbers', async () => {
  const e = await env(ON, 23);
  try {
    const line = e.hq.home.current().quota!.find((q) => q.name === 'codex')!;
    assert.equal(line.label, 'Codex');
    assert.equal(line.seven_day_pct, 23);
    assert.equal(line.five_hour_pct, null);
    assert.equal(line.note, 'לא מקבל משימות חדשות עד האיפוס, כי עבר את התקרה של 20%');
    e.clock.advance(15 * 24 * 3_600_000); // past the reset on 03/11
    assert.equal(e.hq.codexQuota.blocked(), null, 'a read from a week that already reset is unknown, not a block');
    e.limits.set(new Error('codex app-server did not answer'));
    const s = await e.hq.codexQuota.refresh();
    assert.equal(s.usedPercent, 23);
    assert.equal(s.error, 'codex app-server did not answer');
  } finally { await e.cleanup(); }
});

test('the quota is read from codex app-server itself (the fake speaks its protocol)', async () => {
  const fake = new URL('../../adapter/test/fixtures/fake-codex.mjs', import.meta.url).pathname;
  assert.deepEqual(await appServerLimits(fake)(), { usedPercent: 4, resetsAt: 1_900_000_000_000, plan: null });
  assert.deepEqual(parseLimits({ rateLimits: { planType: 'prolite', primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1793742669 } } }),
    { usedPercent: 2, resetsAt: 1_793_742_669_000, plan: 'prolite' });
  await assert.rejects(appServerLimits('/nonexistent/codex', 2000)());
  assert.equal(new CodexQuota(null as never, { codexTaskMaxPercent: 50 } as never, async () => ({ usedPercent: 0, resetsAt: null, plan: null })).maxPercent, 50);
});
