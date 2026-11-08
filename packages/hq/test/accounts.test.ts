import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, UsageReply } from '@company/shared';
import { makeEnv, until } from './helpers.ts';
import { hostArgs } from '../src/shifts.ts';
import { matchesExpect, readProfile, type LoginProcess, type Profile } from '../src/accounts.ts';
import { buildEnv } from '../../adapter/src/spec.ts';
import { whenLocal } from '../src/timezone.ts';
import { pushWorthy } from '../src/inbox.ts';

const PRIMARY: Profile = { email: 'owner-account@example.com', accountUuid: 'uuid-primary', org: 'Ran', plan: 'default_claude_max_20x' };
const SECOND: Profile = { email: 'hive-owner@example.com', accountUuid: 'uuid-1132', org: 'Ran', plan: 'default_claude_max_5x' };

/** Fakes for the three things that touch real Claude: profile, get_usage, `claude auth login`. */
function fakes() {
  const claudeHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
  const profiles = new Map<string | null, Profile>([[null, PRIMARY]]);
  const usage = new Map<string, Partial<UsageReply>>();
  const logins: { dir: string; codes: string[]; exit: (c: number) => void; killed: boolean }[] = [];
  let nextProfile: Profile = SECOND;
  const deps = {
    profile: async (dir: string | null) => {
      const p = profiles.get(dir);
      if (!p) throw new Error('no credentials');
      return p;
    },
    usage: async (a: { name: string }) => ({ fiveHour: 10, sevenDay: 20, resetsAt: {}, raw: null, ...usage.get(a.name) }),
    login: (dir: string): LoginProcess => {
      let exit!: (c: number) => void;
      const done = new Promise<number | null>((r) => { exit = r; });
      const rec = { dir, codes: [] as string[], exit, killed: false };
      logins.push(rec);
      return {
        url: Promise.resolve(`https://claude.com/cai/oauth/authorize?code=true&state=s${logins.length}`), done,
        // Like the CLI: a pasted code completes the login and writes the account's credentials.
        submit: (code) => { rec.codes.push(code); profiles.set(dir, nextProfile); exit(0); },
        kill: () => { rec.killed = true; exit(143); },
      };
    },
  };
  return { claudeHome, profiles, usage, logins, deps, setNext: (p: Profile) => { nextProfile = p; } };
}

// The two accounts hq-host runs on (company/hq.config.json); the generic default is the global login only.
const ACCOUNTS = [
  { name: 'owner-account', label: 'החשבון הראשי', expect: 'owner-account@example.com', managed: false },
  { name: 'hive-owner', label: 'hive-owner', expect: 'hive-owner', managed: true },
];

async function env(f = fakes()) {
  const e = await makeEnv({ cfg: { claudeHome: f.claudeHome, accounts: ACCOUNTS }, deps: { accounts: f.deps } });
  e.hq.store.setToggle('yoav/accounts', true);
  // The identity check at start runs in the background: let it land before a test edits the rows.
  await until(() => e.hq.accounts.get('owner-account')!.health === 'ok' && !!e.hq.accounts.get('hive-owner')!.note, 2000, 'start verify');
  return { ...e, f, acct: e.hq.accounts };
}

test('two accounts registered; the global login has no config dir, the second gets its own with shared symlinks', async () => {
  const e = await env();
  try {
    const rows = e.acct.rows();
    assert.deepEqual(rows.map((r) => r.name), ['owner-account', 'hive-owner']);
    assert.equal(rows[0]!.config_dir, null, 'dir-0016: ~/.claude is never replaced');
    assert.equal(rows[1]!.config_dir, join(e.cfg.stateDir, 'accounts', 'hive-owner'));
    assert.equal(rows[1]!.health, 'needs_login');
    await until(() => e.acct.get('owner-account')!.health === 'ok', 2000, 'primary verified at start');
    assert.equal(e.acct.get('owner-account')!.email, PRIMARY.email);

    e.acct.prepareDir(rows[1]!.config_dir!);
    for (const s of ['projects', 'sessions', 'skills', 'hooks', 'agents']) {
      const link = join(rows[1]!.config_dir!, s);
      assert.ok(lstatSync(link).isSymbolicLink(), `${s} is shared`);
      assert.equal(readlinkSync(link), join(e.f.claudeHome, s));
    }
  } finally { await e.cleanup(); }
});

test('guided login: link reaches him as an hq ask, the pasted code completes it, identity verified, code not kept', async () => {
  const e = await env();
  try {
    await assert.rejects(e.acct.startLogin('owner-account'), /dir-0016/);
    const { askId } = await e.acct.startLogin('hive-owner');
    const ask = e.hq.mailbox.getAsk(askId)!;
    assert.equal(ask.from_identity, 'hq');
    assert.match(ask.question, /https:\/\/claude\.com\/cai\/oauth\/authorize/);
    assert.equal(e.hq.inbox.open().filter((i) => i.ref === askId).length, 1, 'waits for him in the inbox');
    assert.equal(e.f.logins[0]!.dir, join(e.cfg.stateDir, 'accounts', 'hive-owner'));

    e.hq.mailbox.answer(askId, '  abc#xyz \n');
    await until(() => e.acct.get('hive-owner')!.health === 'ok', 2000, 'verified');
    assert.deepEqual(e.f.logins[0]!.codes, ['abc#xyz']);
    assert.equal(e.acct.get('hive-owner')!.email, SECOND.email);
    assert.equal(e.hq.mailbox.getAsk(askId)!.answer, '(התקבל)', 'the one-time code is not stored');
    const leaked = e.hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE data LIKE '%abc#xyz%'`).get() as { n: number };
    assert.equal(leaked.n, 0, 'nor in the event log (and so not in backups)');
    const toHq = e.hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE to_identity = 'hq'`).get() as { n: number };
    assert.equal(toHq.n, 0, 'no message to hq (it has no mailbox)');
  } finally { await e.cleanup(); }
});

test('a login ask left over from before a restart is closed at start (its code would go nowhere)', async () => {
  const e = await env();
  try {
    const { askId } = await e.acct.startLogin('hive-owner');
    // Simulate a fresh hq on the same store: no login process behind the ask.
    (e.acct as unknown as { pending: Map<string, unknown> }).pending.clear();
    e.acct.sync();
    assert.equal(e.hq.mailbox.getAsk(askId)!.state, 'cancelled');
    assert.equal(e.hq.inbox.open().filter((i) => i.ref === askId).length, 0);
  } finally { await e.cleanup(); }
});

test('identity check: the wrong account or one already registered is rejected, and a new link is offered', async () => {
  const e = await env();
  try {
    await until(() => e.acct.get('owner-account')!.account_uuid === PRIMARY.accountUuid, 2000, 'primary uuid');
    // He approved it in a browser that was logged in as the main account (B.7 ⚠): same account, other email cache.
    e.f.setNext({ ...PRIMARY });
    const first = await e.acct.startLogin('hive-owner');
    e.hq.mailbox.answer(first.askId, 'code1');
    await until(() => e.f.logins.length === 2, 2000, 'second link');
    const r = e.acct.get('hive-owner')!;
    assert.equal(r.health, 'wrong_account');
    assert.equal(r.note, 'התחברת כ-owner-account@example.com, ביקשת hive-owner. נסה שוב.');
    assert.equal(e.acct.usable(r), false, 'never used while wrong');
    const retry = e.hq.mailbox.openAsks().find((a) => a.from_identity === 'hq' && a.state === 'open')!;
    assert.match(retry.question, /התחברת כ-owner-account@example.com, ביקשת hive-owner/);

    // Right local part, but the same account uuid as the main one → still rejected.
    e.f.setNext({ ...SECOND, accountUuid: PRIMARY.accountUuid });
    e.hq.mailbox.answer(retry.id, 'code2');
    await until(() => e.f.logins.length === 3, 2000, 'third link');
    assert.match(e.acct.get('hive-owner')!.note!, /אותו חשבון כמו החשבון הראשי/);

    e.f.setNext(SECOND);
    const third = e.hq.mailbox.openAsks().find((a) => a.from_identity === 'hq' && a.state === 'open')!;
    e.hq.mailbox.answer(third.id, 'code3');
    await until(() => e.acct.get('hive-owner')!.health === 'ok', 2000, 'right account');
  } finally { await e.cleanup(); }
});

test('matchesExpect: full email exact, bare handle = local part', () => {
  assert.ok(matchesExpect('Hive-Owner@example.com', 'hive-owner'));
  assert.ok(!matchesExpect('owner-account@example.com', 'hive-owner'));
  assert.ok(matchesExpect('owner-account@example.com', 'owner-account@example.com'));
  assert.ok(!matchesExpect('owner-account@other.com', 'owner-account@example.com'));
});

test('readProfile falls back to the CLI cache (~/.claude.json next to ~/.claude) when the API is unreachable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const claude = join(home, '.claude');
  mkdirSync(claude);
  writeFileSync(join(claude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', subscriptionType: 'max' } }));
  writeFileSync(`${claude}.json`, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', accountUuid: 'u1', organizationName: 'O' } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  try {
    assert.deepEqual(await readProfile(null, claude), { email: 'a@b.c', accountUuid: 'u1', org: 'O', plan: 'max' });
  } finally { globalThis.fetch = realFetch; }
});

test('quota + placement: most room wins, a tie goes to the week that resets first, a full account is blocked', async () => {
  const e = await env();
  try {
    await until(() => e.acct.get('owner-account')!.health === 'ok', 2000, 'primary');
    // Unverified second account is never picked.
    assert.equal(e.acct.pick()!.name, 'owner-account');
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();

    e.f.usage.set('owner-account', { fiveHour: 30, sevenDay: 80, resetsAt: { sevenDay: '2026-10-25T00:00:00Z' } });
    e.f.usage.set('hive-owner', { fiveHour: 5, sevenDay: 10, resetsAt: { sevenDay: '2026-10-27T00:00:00Z' } });
    await e.acct.refresh();
    assert.equal(e.acct.get('owner-account')!.seven_day_pct, 80);
    assert.equal(e.acct.pick()!.name, 'hive-owner', 'more room');

    e.f.usage.set('hive-owner', { fiveHour: 5, sevenDay: 80, resetsAt: { sevenDay: '2026-10-27T00:00:00Z' } });
    await e.acct.refresh();
    assert.equal(e.acct.pick()!.name, 'owner-account', 'tie → use it or lose it');

    e.f.usage.set('owner-account', { fiveHour: 100, sevenDay: 80, resetsAt: { fiveHour: '2026-10-20T12:00:00Z' } });
    await e.acct.refresh();
    assert.equal(e.acct.get('owner-account')!.blocked_until, Date.parse('2026-10-20T12:00:00Z'));
    assert.equal(e.acct.pick()!.name, 'hive-owner');
    assert.equal(e.acct.view().active, 'hive-owner');
  } finally { await e.cleanup(); }
});

test('automatic switch: rate limit rejected → same session resumes on the other account, the worker is told', async () => {
  const e = await env();
  try {
    const { hq, launcher, clock } = e;
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();
    e.f.usage.set('hive-owner', { fiveHour: 50, sevenDay: 50 });
    await e.acct.refresh();
    const row = await hq.shifts.request('rotem', { reason: 'manual', kind: 'work' });
    await until(() => hq.shifts.get(row.id)!.state === 'live', 2000, 'live');
    assert.equal(hq.shifts.get(row.id)!.account, 'owner-account');
    assert.equal(launcher.launches.at(-1)!.configDir, null);

    const host = launcher.hosts.get(row.id)!;
    const resetsAt = Math.floor(clock.now() / 1000) + 3 * 3600;
    host.event({ kind: 'rate_limit', status: 'rejected', rateLimitType: 'five_hour', resetsAt, fiveHour: 1, sevenDay: 0.6 } as EngineEvent);
    await until(() => launcher.launches.length === 2 && hq.shifts.get(row.id)?.state === 'live', 3000, 'resumed on the other account');

    const l = launcher.launches.at(-1)!;
    assert.equal(l.shiftId, row.id, 'same shift');
    assert.equal(l.resume, true, '--resume of the same session');
    assert.equal(l.sessionId, row.session_id);
    assert.equal(l.account, 'hive-owner');
    assert.equal(l.configDir, join(e.cfg.stateDir, 'accounts', 'hive-owner'));
    assert.equal(hostArgs(l, e.cfg.stateDir)['config-dir'], l.configDir);
    assert.equal(hq.shifts.get(row.id)!.account, 'hive-owner');
    const a = e.acct.get('owner-account')!;
    assert.equal(a.blocked_until, resetsAt * 1000);
    assert.equal(a.five_hour_pct, 100);
    await until(() => !!hq.store.db.prepare(`SELECT 1 FROM messages WHERE to_identity = 'rotem' AND from_identity = 'hq' AND body LIKE '%המשך מאיפה שעצרת%'`).get(), 2000, 'told');

    // Both blocked: the shift parks (no third launch); the board shows the quota block.
    launcher.hosts.get(row.id)!.event({ kind: 'rate_limit', status: 'rejected', resetsAt: resetsAt + 60 } as EngineEvent);
    await until(() => e.acct.blocked(e.acct.get('hive-owner')!), 2000, 'second blocked');
    await new Promise((r) => setTimeout(r, 100));
    // rotem's: no third.
    assert.equal(launcher.launches.filter((x) => x.shiftId === row.id).length, 2);
  } finally { await e.cleanup(); }
});

test('a rejection missed while hq was down: the account counts as blocked and the next sweep moves the shift', async () => {
  const e = await env();
  try {
    const { hq, launcher, clock } = e;
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();
    e.f.usage.set('hive-owner', { fiveHour: 50, sevenDay: 50 });
    await e.acct.refresh();
    const row = await hq.shifts.request('rotem', { reason: 'manual', kind: 'work' });
    await until(() => hq.shifts.get(row.id)!.state === 'live', 2000, 'live');
    // Replayed frame (live=false), as after a reconnect: no switch right then.
    hq.shifts.emit('frame', hq.shifts.get(row.id)!, { t: 'event', seq: 999, ts: '', ev: { kind: 'rate_limit', status: 'rejected',
      resetsAt: Math.floor(clock.now() / 1000) + 3600 } } as never, false);
    assert.ok(e.acct.blocked(e.acct.get('owner-account')!));
    assert.equal(launcher.launches.length, 1);
    // With the automation off, a sweep reads quota but moves nothing.
    hq.store.setToggle('yoav/accounts', false);
    await e.acct.refresh();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(launcher.launches.length, 1);
    hq.store.setToggle('yoav/accounts', true);
    await e.acct.refresh();
    await until(() => launcher.launches.length === 2 && hq.shifts.get(row.id)?.account === 'hive-owner', 3000, 'rebalanced');
  } finally { await e.cleanup(); }
});

test('a task worker keeps its task across a switch: no requeue, no second task prompt', async () => {
  const e = await env();
  try {
    const { hq, launcher } = e;
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();
    e.f.usage.set('hive-owner', { fiveHour: 50, sevenDay: 50 });
    await e.acct.refresh();
    const t = hq.scheduler.addTask({ title: 'משימה' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running');
    const sid = hq.scheduler.task(t.id)!.shift_id!;
    await until(() => hq.shifts.get(sid)!.state === 'live', 2000, 'live');
    launcher.hosts.get(sid)!.event({ kind: 'rate_limit', status: 'rejected', resetsAt: Math.floor(e.clock.now() / 1000) + 3600 } as EngineEvent);
    await until(() => launcher.launches.length === 2 && hq.shifts.get(sid)?.state === 'live', 3000, 'switched');
    assert.equal(launcher.launches.at(-1)!.cwd, launcher.launches[0]!.cwd, 'same cwd');
    assert.equal(launcher.launches.at(-1)!.taskId, t.id);
    assert.equal(hq.scheduler.task(t.id)!.state, 'running');
    const prompts = hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE id LIKE ?`).get(`task-${t.id}-%`) as { n: number };
    assert.equal(prompts.n, 1);
  } finally { await e.cleanup(); }
});

test('"כולם ל-X": new runs go to X and an idle live shift moves now', async () => {
  const e = await env();
  try {
    const { hq, launcher } = e;
    const row = await hq.shifts.request('rotem', { reason: 'manual', kind: 'work' });
    await until(() => hq.shifts.get(row.id)!.state === 'live', 2000, 'live');
    assert.throws(() => e.acct.setPinned('hive-owner'), /עוד לא מחובר/);
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();
    e.f.usage.set('hive-owner', { fiveHour: 90, sevenDay: 90 });
    await e.acct.refresh();
    e.acct.setPinned('hive-owner');
    assert.equal(e.acct.pick()!.name, 'hive-owner', 'pin beats room');
    await until(() => launcher.launches.length === 2 && hq.shifts.get(row.id)?.account === 'hive-owner', 3000, 'moved');
    assert.equal(launcher.launches.at(-1)!.resume, true);
    e.acct.setPinned(null);
    assert.equal(e.acct.pick()!.name, 'owner-account');
  } finally { await e.cleanup(); }
});

test('adapter: a managed account runs with its own CLAUDE_CONFIG_DIR; no account = the inherited one is dropped', () => {
  const spec = { identity: 'x', shift: 'x-1', sessionId: 's', resume: false, cwd: '/', settingsFile: '', stateRoot: '/s' };
  assert.equal(buildEnv({ ...spec, configDir: '/s/accounts/hive-owner' }, { CLAUDE_CONFIG_DIR: '/other' }).CLAUDE_CONFIG_DIR, '/s/accounts/hive-owner');
  assert.equal(buildEnv(spec, { CLAUDE_CONFIG_DIR: '/other' }).CLAUDE_CONFIG_DIR, undefined);
});

test('all accounts full: one urgent item for him (the manager can\'t work either) with the first reset, kept as one, closed by itself with a "חזרנו" message', async () => {
  const e = await env();
  try {
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();
    const items = () => e.hq.store.db.prepare(`SELECT * FROM inbox WHERE ref = 'accounts-all-full'`).all() as { id: number; state: string; title: string; body: string; urgency: string; kind: string }[];
    const back = () => e.hq.store.db.prepare(`SELECT body, from_identity, priority FROM messages WHERE to_identity = 'owner' AND id LIKE 'accounts-all-full-back-%'`).all() as { body: string; from_identity: string; priority: string }[];

    // One full, one open: nothing for him.
    e.f.usage.set('owner-account', { fiveHour: 40, sevenDay: 100, resetsAt: { sevenDay: '2026-10-22T04:00:00Z' } });
    e.f.usage.set('hive-owner', { fiveHour: 10, sevenDay: 60, resetsAt: { sevenDay: '2026-10-21T12:00:00Z' } });
    await e.acct.refresh();
    assert.equal(e.acct.allFull(), false);
    assert.equal(items().length, 0);

    // Both full (the 23/10 case): one item, urgent, with the earliest reset in his words.
    e.f.usage.set('hive-owner', { fiveHour: 10, sevenDay: 100, resetsAt: { sevenDay: '2026-10-21T12:00:00Z' } });
    await e.acct.refresh();
    assert.equal(e.acct.allFull(), true);
    let it = items();
    assert.equal(it.length, 1);
    assert.equal(it[0]!.kind, 'incident');
    assert.equal(it[0]!.urgency, 'urgent');
    assert.equal(it[0]!.title, 'כל החשבונות של Claude מלאים, והעבודה עומדת עד מחר ב-12:00');
    assert.match(it[0]!.body, /hive-owner: 5 שעות 10%, שבועי 100%\. נפתח מחר ב-12:00\./);
    assert.match(it[0]!.body, /החשבון הראשי: 5 שעות 40%, שבועי 100%\. נפתח יום חמישי 22\/10 ב-04:00\./);
    // Task 986: a fault of the system is the manager's, but not this one: with every account full the manager can't work
    // either, so it is his, pushed, and not sent to the manager (who would only fail to get it).
    assert.ok(pushWorthy(e.hq.inbox.get(it[0]!.id)!, false, e.hq.inbox.manager), 'pushed to him');
    assert.ok(e.hq.inbox.mine().some((i) => i.id === it[0]!.id), 'in what waits on him');
    assert.equal(e.hq.store.db.prepare(`SELECT 1 FROM messages WHERE id = ?`).get(`inbox-${it[0]!.id}-to-manager`), undefined, 'not to the manager');

    // Still full on the next sweeps: still the same one item.
    await e.acct.refresh();
    e.clock.advance(3600_000);
    await e.acct.refresh();
    assert.equal(items().length, 1);
    assert.equal(items()[0]!.state, 'open');

    // The night's empty-slot reason reads the same.
    assert.equal(e.hq.night.accountsFull(), true);

    // A reset passes: the item closes and he is told once.
    e.clock.t = Date.parse('2026-10-21T12:05:00Z');
    e.f.usage.set('hive-owner', { fiveHour: 0, sevenDay: 0, resetsAt: { sevenDay: '2026-10-28T12:00:00Z' } });
    await e.acct.refresh();
    it = items();
    assert.equal(it[0]!.state, 'resolved');
    const b = back();
    assert.equal(b.length, 1);
    assert.equal(b[0]!.from_identity, 'yoav');
    assert.equal(b[0]!.priority, 'now');
    assert.equal(b[0]!.body, 'חזרנו: החשבון hive-owner פתוח שוב, והעבודה ממשיכה (עמדנו 27 שעות).');
    await e.acct.refresh();
    assert.equal(back().length, 1, 'once');

    // Full again later: a new item. Its account losing its login meanwhile is no "חזרנו", and is named in the item.
    e.f.usage.set('owner-account', { fiveHour: 100, sevenDay: 5, resetsAt: { fiveHour: '2026-10-21T16:00:00Z' } });
    e.f.usage.set('hive-owner', { fiveHour: 100, sevenDay: 5, resetsAt: { fiveHour: '2026-10-21T15:00:00Z' } });
    await e.acct.refresh();
    assert.equal(items().filter((i) => i.state === 'open').length, 1);
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'needs_login' WHERE name = 'hive-owner'`).run();
    e.f.usage.set('owner-account', { fiveHour: 100, sevenDay: 5, resetsAt: { fiveHour: '2026-10-21T16:00:00Z' } });
    await e.acct.refresh();
    assert.equal(back().length, 1, 'no false "back"');
    assert.match(items().find((i) => i.state === 'open')!.body, /- hive-owner: לא מחובר\./);
    // The automation turned off: the item closes quietly.
    e.hq.store.setToggle('yoav/accounts', false);
    e.acct.watchFull();
    assert.equal(items().filter((i) => i.state === 'open').length, 0);
    assert.equal(back().length, 1);
    e.hq.store.setToggle('yoav/accounts', true);
    e.hq.store.db.prepare(`UPDATE accounts SET health = 'ok' WHERE name = 'hive-owner'`).run();
    e.f.usage.set('owner-account', { fiveHour: 0, sevenDay: 5 });
    e.f.usage.set('hive-owner', { fiveHour: 0, sevenDay: 5 });
    await e.acct.refresh();
    // A third time full.
    e.f.usage.set('owner-account', { fiveHour: 100, sevenDay: 5, resetsAt: { fiveHour: '2026-10-21T16:00:00Z' } });
    e.f.usage.set('hive-owner', { fiveHour: 100, sevenDay: 5, resetsAt: { fiveHour: '2026-10-21T15:00:00Z' } });
    await e.acct.refresh();
    assert.equal(items().filter((i) => i.state === 'open').length, 1);
    assert.equal(items().length, 3);
  } finally { await e.cleanup(); }
});

test('the same Claude account twice is one account: a stale row is dropped, a configured duplicate is not capacity', async () => {
  const f = fakes();
  // The second configured account turns out to be the global login again (same account_uuid).
  f.profiles.set(join(mkdtempSync(join(tmpdir(), 'x-')), 'unused'), PRIMARY);
  const e = await makeEnv({ cfg: { claudeHome: f.claudeHome, accounts: [...ACCOUNTS, { name: 'claude', label: 'Claude', expect: '', managed: false }] }, deps: { accounts: f.deps } });
  try {
    e.hq.store.setToggle('yoav/accounts', true);
    await until(() => e.hq.accounts.get('claude')?.account_uuid === PRIMARY.accountUuid && e.hq.accounts.get('owner-account')?.account_uuid === PRIMARY.accountUuid, 2000, 'both verified');
    const acct = e.hq.accounts;
    // Registered first, it stays the real one; the later one is the duplicate.
    assert.equal(acct.get('owner-account')!.health, 'ok');
    assert.equal(acct.get('claude')!.health, 'wrong_account');
    assert.equal(acct.duplicateOf(acct.get('claude')!)?.name, 'owner-account');
    assert.deepEqual(acct.capacity().map((r) => r.name), ['owner-account']);
    assert.equal(acct.view().accounts.find((a) => a.name === 'claude')!.usable, false);
    assert.equal(acct.view().accounts.find((a) => a.name === 'claude')!.duplicate_of, 'owner-account');
    assert.deepEqual(acct.quota().map((q) => q.name), ['owner-account', 'hive-owner']);
    assert.throws(() => acct.setPinned('claude'), /אותו חשבון כמו החשבון הראשי/);

    // A full primary: the duplicate's room is not counted, so everything is full.
    e.hq.store.db.prepare(`UPDATE accounts SET seven_day_pct = 100, seven_day_resets_at = ? WHERE name = 'owner-account'`).run(e.clock.now() + 3600_000);
    e.hq.store.db.prepare(`UPDATE accounts SET seven_day_pct = 0 WHERE name = 'claude'`).run();
    assert.equal(acct.allFull(), true);

    // Taken out of hq.config.json (hq-host, 21/10): its row goes at the next start.
    e.cfg.accounts = ACCOUNTS;
    acct.sync();
    assert.equal(acct.get('claude'), undefined);
  } finally { await e.cleanup(); }
});

test('whenLocal: today, tomorrow, or the weekday and date, in the company zone', () => {
  const now = Date.parse('2026-10-24T09:00:00Z'); // Saturday 12:00 in Jerusalem
  assert.equal(whenLocal(Date.parse('2026-10-24T18:30:00Z'), now, 'Asia/Jerusalem'), 'היום ב-21:30');
  assert.equal(whenLocal(Date.parse('2026-10-25T11:59:59Z'), now, 'Asia/Jerusalem'), 'מחר ב-13:59');
  // Summer time until 25/10 (+3): after 21:00 UTC it is already the next day; the 25th onwards is +2.
  assert.equal(whenLocal(Date.parse('2026-10-24T21:30:00Z'), now, 'Asia/Jerusalem'), 'מחר ב-00:30');
  assert.equal(whenLocal(Date.parse('2026-10-31T04:00:00Z'), now, 'Asia/Jerusalem'), 'יום שבת 31/10 ב-06:00');
});
