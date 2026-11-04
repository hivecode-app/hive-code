import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ORG_YAML, makeEnv } from './helpers.ts';
import { CONSENT_VERSION, connectionStatus, repositories, workSettings, saveWorkSettings, scheduledNight } from '../src/onboarding.ts';
import { sufficientUntil } from '../src/usage.ts';

async function setupEnv(pending = true) {
  const env = await makeEnv({ noStart: true, org: pending ? `${ORG_YAML}\nsetup: pending\n` : ORG_YAML,
    deps: { setupCommand: async (file, args) => file === 'claude' ? '{"loggedIn":true}' : args[1] === 'user' ? 'owner' : '[]' } });
  await env.hq.start({ listen: true, timers: false });
  const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
  const code = env.hq.auth.createPairCode({ kind: 'admin' }).code;
  const phone = env.hq.auth.pair(code, 'Phone', 'test').token;
  const call = async (path: string, body?: unknown, auth = phone) => {
    const r = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, { method: body == null ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, value: await r.json() as Record<string, any> };
  };
  return { ...env, call, token, phone };
}

test('new setup: device acknowledgement gates workers; projects and first conversation survive duplicate start', async () => {
  const env = await setupEnv();
  try {
    const { hq, call } = env;
    assert.equal((await call('/api/setup')).value.pending, true);
    assert.equal((await call('/api/setup/start', {})).status, 403);
    await assert.rejects(hq.shifts.request('adi', { reason: 'manual' }), /Setup needs/);
    assert.equal(env.launcher.hosts.size, 0);
    assert.equal((await call('/api/consent', { accepted: true, version: 'old', language: 'en' })).status, 400);
    const consent = { accepted: true, version: CONSENT_VERSION, language: 'en' };
    assert.equal((await call('/api/consent', consent)).status, 200);
    await call('/api/consent', consent);
    const rows = hq.store.db.prepare('SELECT * FROM consents').all() as Record<string, unknown>[];
    assert.equal(rows.length, 1); assert.equal(rows[0]!.accepted_at, env.clock.now()); assert.match(String(rows[0]!.device), /^dev_/);
    assert.equal((await call('/api/setup/start', {})).status, 403);
    assert.equal((await call('/api/setup/projects', { selected: ['owner/one', 'owner/two'] })).status, 200);
    const org = parse(readFileSync(join(env.cfg.companyDir, 'org.yaml'), 'utf8'));
    assert.deepEqual(org.setup_repositories, ['owner/one', 'owner/two']);
    const results = await Promise.all([call('/api/setup/start', {}), call('/api/setup/start', {})]);
    assert.deepEqual(results.map(r => r.status), [200, 200]);
    assert.equal((hq.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'first-company-setup'").get() as { n: number }).n, 1);
    assert.equal((await call('/api/setup')).value.started, true);
    assert.equal((await call('/api/setup/projects', { selected: ['owner/other'] })).status, 409);
  } finally { await env.cleanup(); }
});

test('existing company pairs directly; device and admin access required', async () => {
  const env = await setupEnv(false);
  try {
    assert.equal((await env.call('/api/setup')).value.pending, false);
    assert.equal((await env.call('/api/setup', undefined, 'bad')).status, 401);
    assert.equal(workSettings(env.hq.store, env.cfg).nightEnabled, false);
    assert.equal(workSettings(env.hq.store, env.cfg).autoAccounts, true);
    assert.equal((await env.call('/api/setup/projects', { selected: ['owner/repo'] })).status, 409);
  } finally { await env.cleanup(); }
});

test('work settings validate, persist and apply capacity without changing access or telegram', async () => {
  const env = await setupEnv();
  try {
    const { hq, cfg } = env;
    assert.equal(workSettings(hq.store, cfg).nightEnabled, true);
    assert.equal(workSettings(hq.store, cfg).autoAccounts, false);
    const body = { parallel: 2, nightEnabled: false, autoAccounts: true, nightStart: '23:00', nightEnd: '07:00' };
    assert.equal((await env.call('/api/settings/work', body)).status, 200);
    assert.equal(cfg.capacity.maxSlots, 2);
    assert.equal(workSettings(hq.store, cfg).parallel, 2);
    assert.equal((await env.call('/api/settings/work', { parallel: 0 })).status, 400);
    assert.equal((await env.call('/api/settings/work', { nightStart: '29:30' })).status, 400);
    assert.deepEqual((await env.call('/api/settings/work')).value.settings, body);
    assert.equal(cfg.telegramChat, '');
    assert.equal(hq.scheduler.slots().total <= 2, true);
  } finally { await env.cleanup(); }
});

test('connection failures are independent and repository pagination distinguishes permission failure', async () => {
  const run = async (file: string, args: string[]) => {
    if (file === 'claude') throw new Error('not logged in');
    if (args[1] === 'user') return 'owner';
    assert.match(args[1]!, /page=2/);
    return JSON.stringify([{ full_name: 'owner/a', description: 'A', permissions: { push: true } }, { full_name: 'owner/read-only', permissions: { push: false } }]);
  };
  assert.equal(await connectionStatus('claude', run), false);
  assert.equal(await connectionStatus('github', run), true);
  assert.deepEqual((await repositories(2, run)).repos.map(r => r.name), ['owner/a']);
  await assert.rejects(repositories(0, run), /invalid page/);
});

test('forecast uses a full day rate and stops at reset, without inventing history', () => {
  const now = Date.UTC(2026, 10, 4), day = 86_400_000;
  assert.equal(sufficientUntil(now, 20, 40, now + 5 * day), now + 2 * day);
  assert.equal(sufficientUntil(now, 10, 80, now + 2 * day), now + 2 * day);
  assert.equal(sufficientUntil(now, null, 80, now + day), null);
  assert.equal(sufficientUntil(now, 0, 80, now + day), null);
});

test('public login attempts are limited per address and recover after the minute', async () => {
  const env = await setupEnv(false);
  try {
    const base = `http://127.0.0.1:${env.hq.port}`;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"WRONG"}' });
      assert.equal(r.status, 401);
    }
    const code = env.hq.auth.createPairCode({ kind: 'admin' }).code;
    const pair = () => fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal((await pair()).status, 429);
    env.clock.advance(60_001);
    assert.equal((await pair()).status, 200);
  } finally { await env.cleanup(); }
});

test('night schedule follows company time and starts only once per window', async () => {
  const env = await setupEnv(false);
  try {
    const file = join(env.cfg.companyDir, 'org.yaml');
    writeFileSync(file, `${ORG_YAML}\ntimezone: Asia/Jerusalem\n`);
    env.clock.t = Date.UTC(2026, 10, 4, 21, 5); // 23:05 in Jerusalem.
    saveWorkSettings(env.hq.store, env.cfg, { nightEnabled: true });
    await scheduledNight(env.hq);
    const first = env.hq.night.current();
    assert.ok(first);
    await scheduledNight(env.hq);
    assert.equal(env.hq.night.current()?.id, first.id);
    env.hq.night.end('owner');
    await scheduledNight(env.hq);
    assert.equal(env.hq.night.current(), undefined);
  } finally { await env.cleanup(); }
});

test('valid pairing pages never lock login and a second forwarded client stays independent', async () => {
  const env = await setupEnv(false);
  try {
    const base = `http://127.0.0.1:${env.hq.port}`;
    for (let i = 0; i < 12; i++) assert.equal((await fetch(`${base}/pair?code=ABCD-EFGH`)).status, 200);
    for (let i = 0; i < 10; i++) await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' }, body: '{"code":"WRONG"}' });
    const options = await fetch(`${base}/api/auth/login/options`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.1' }, body: '{}' });
    assert.equal(options.status, 200, 'wrong pairing codes do not lock a passkey');
    const code = env.hq.auth.createPairCode({ kind: 'admin' }).code;
    const pair = await fetch(`${base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.2' }, body: JSON.stringify({ code }) });
    assert.equal(pair.status, 200);
  } finally { await env.cleanup(); }
});
