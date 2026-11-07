// Task 1476: "מחכה לפריסה" clears by what production runs (live.ts), for each reason it stayed before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AwaitingBoard } from '../src/awaiting.ts';
import { LiveWatch, partsFor, shasOf, type LiveGit } from '../src/live.ts';
import { Store } from '../src/store.ts';
import { liveParts, type LivePart } from '../src/workspace.ts';

/** A repo's history as parent links: commit → its parent. */
type History = Record<string, string | null>;

function fakeGit(repos: Record<string, { history: History; prs: Record<string, { sha: string | null; files: string[] }> }>) {
  const calls = { pr: 0, contains: 0 };
  const git: LiveGit = {
    async pr(repo, n) {
      calls.pr++;
      const p = repos[repo]?.prs[n];
      if (!p) throw new Error(`no PR ${repo}#${n}`);
      return p.sha ? { merged: true, sha: p.sha, files: p.files } : { merged: false, sha: null, files: [] };
    },
    async contains(repo, ancestor, tip) {
      calls.contains++;
      const h = repos[repo]!.history;
      for (let c: string | null | undefined = tip; c; c = h[c]) if (c === ancestor) return true;
      return false;
    },
  };
  return { git, calls };
}

function setup(parts: Record<string, LivePart[]>, out: Record<string, string | Error>, repos: Parameters<typeof fakeGit>[0], defaults: Record<string, string> = {}) {
  let t = Date.UTC(2026, 10, 7, 12);
  const store = new Store(':memory:', { now: () => t });
  const awaiting = new AwaitingBoard(store);
  awaiting.defaultRepoOf = (p) => defaults[p] ?? null;
  awaiting.repoOf = (p) => defaults[p] ?? null; // a project with one checkout: its worktree tells the repo
  const { git, calls } = fakeGit(repos);
  const ran: string[] = [];
  const live = new LiveWatch(store, awaiting, (p) => parts[p] ?? [], {
    git, run: async (cmd) => { ran.push(cmd); const o = out[cmd]; if (o instanceof Error) throw o; return o ?? ''; },
  });
  const task = (project: string, a: { pr?: string; awaiting?: string } = {}) => {
    const id = Number(store.db.prepare(`INSERT INTO tasks (project, title, state, created_at, updated_at) VALUES (?, 't', 'done', ?, ?)`).run(project, t, t).lastInsertRowid);
    awaiting.mark(id, { awaiting: a.awaiting ?? 'deploy', pr: a.pr }, 'w');
    return id;
  };
  return { store, awaiting, live, task, calls, ran, advance: (ms: number) => { t += ms; } };
}

const part = (p: Partial<LivePart> & { part: string; repo: string }): LivePart => ({ paths: null, sha: `sha-of ${p.part}`, ...p });

test('shasOf: every commit-looking word once; a sha256 digest and words are not commits', () => {
  assert.deepEqual(shasOf('57f7c3f\n57f7c3f\nb4c6f4e2a1\n'), ['57f7c3f', 'b4c6f4e2a1']);
  assert.deepEqual(shasOf(`sha256:${'a'.repeat(64)} 1.2.67 release`), []);
  assert.deepEqual(shasOf(''), []);
  assert.deepEqual(shasOf('1794061334 20261107'), [], 'digits alone are a number, not a commit');
});

test('partsFor: a part with no paths takes every file; paths are prefixes, in the PR\'s own repo only', () => {
  const parts = [part({ part: 'worker', repo: 'o/bot', paths: ['user-flow-worker/', 'shared'] }), part({ part: 'site', repo: 'o/bot', paths: ['web/'] }),
    part({ part: 'all', repo: 'o/other' })];
  assert.deepEqual(partsFor(parts, 'o/bot', ['user-flow-worker/main.go', 'docs/x.md']).map((p) => p.part), ['worker']);
  assert.deepEqual(partsFor(parts, 'O/Bot', ['shared/a.go', 'web/i.html']).map((p) => p.part), ['worker', 'site']);
  assert.deepEqual(partsFor(parts, 'o/bot', ['sharedx/a.go']).map((p) => p.part), [], 'a prefix is a directory');
  assert.deepEqual(partsFor(parts, 'o/other', ['README.md']).map((p) => p.part), ['all']);
});

test('liveParts: a part needs a name, a command and a repo (its own or the charter\'s)', () => {
  assert.deepEqual(liveParts([{ part: 'hq', sha: 'cat x' }, { part: 'x' }, { sha: 'y' }, { part: 'c', repo: 'o/c', paths: ['a/', 3], sha: 'z' }], 'o/main'), [
    { part: 'hq', repo: 'o/main', paths: null, sha: 'cat x' },
    { part: 'c', repo: 'o/c', paths: ['a/'], sha: 'z' },
  ]);
  assert.deepEqual(liveParts([{ part: 'hq', sha: 'cat x' }], null), [], 'no repo: nothing to compare with');
  assert.deepEqual(liveParts(undefined, 'o/main'), []);
});

test('a project that never reports a deploy (tiki-bot-go, pinto, lumo, small-apps): what production runs clears it', async () => {
  const s = setup({ bot: [part({ part: 'worker', repo: 'o/bot' })] }, { 'sha-of worker': 'c3333333\n' },
    { 'o/bot': { history: { c3333333: 'c2222222', c2222222: 'c1111111', c1111111: null }, prs: { '10': { sha: 'c2222222', files: ['a.go'] }, '11': { sha: 'c4444444', files: ['a.go'] } } } },
    { bot: 'o/bot' });
  const live = s.task('bot', { pr: '10' });
  const later = s.task('bot', { pr: '11' });
  assert.deepEqual(await s.live.tick(), [live]);
  assert.equal(s.awaiting.get(live), null);
  assert.equal(s.awaiting.get(later)?.awaiting, 'deploy', 'merged after what runs: still waits');
  assert.deepEqual(s.live.verdicts.get(later), { id: later, live: false, why: 'behind', parts: ['worker'] });
  const ev = s.store.db.prepare(`SELECT data FROM events WHERE type = 'task.awaiting' AND json_extract(data, '$.id') = ?`).all(live).map((r: any) => JSON.parse(r.data));
  assert.equal(ev.at(-1).why, 'deployed');
  assert.equal(ev.at(-1).by, 'live:worker');
});

test('a deploy report that did not name the PR (lumo-bot rows 125 and 191): the part it put up clears it anyway', async () => {
  const s = setup({ 'lumo-bot': [part({ part: 'gateway', repo: 'o/nsb', paths: ['lumo-app-gateway/'] }), part({ part: 'controller', repo: 'o/nsb', paths: ['controller/'] })] },
    { 'sha-of gateway': 'aaa9999', 'sha-of controller': 'aaa1111' },
    { 'o/nsb': { history: { aaa9999: 'aaa5555', aaa5555: 'aaa1111', aaa1111: null }, prs: { '147': { sha: 'aaa5555', files: ['lumo-app-gateway/x.ts'] } } } },
    { 'lumo-bot': 'o/nsb' });
  const id = s.task('lumo-bot', { pr: '147' });
  s.awaiting.deployed({ project: 'lumo-bot', sha: 'aaa1111', target: 'user-worker-controller', prs: ['134'] });
  assert.equal(s.awaiting.get(id)?.awaiting, 'deploy', 'the report named other PRs');
  assert.deepEqual(await s.live.tick(), [id], 'only the gateway part is needed, and it runs it');
});

test('a PR of the project\'s second repo (my-company#69 under agent-company): a report of the first repo\'s #69 does not take it; its own part does', async () => {
  const s = setup({ 'agent-company': [part({ part: 'hq', repo: 'o/engine' }), part({ part: 'contract', repo: 'o/company' })] },
    { 'sha-of hq': 'eee0001', 'sha-of contract': 'ccc0002' },
    { 'o/engine': { history: { eee0001: null }, prs: {} }, 'o/company': { history: { ccc0002: 'ccc0001', ccc0001: null }, prs: { '69': { sha: 'ccc0001', files: ['company/x.md'] } } } },
    { 'agent-company': 'o/engine' });
  const id = s.task('agent-company', { pr: 'https://github.com/o/company/pull/69' });
  assert.equal(s.awaiting.get(id)?.pr_repo, 'o/company', 'the link keeps its repo');
  assert.deepEqual(s.awaiting.deployed({ project: 'agent-company', sha: 'eee0001', prs: ['69'] }).cleared, [], 'engine#69 is another PR');
  assert.deepEqual(s.awaiting.deployed({ project: 'agent-company', sha: 'x', repo: 'o/company', prs: ['69'] }).cleared, [id], 'a report of its repo still clears it');
  const again = s.task('agent-company', { pr: 'https://github.com/o/company/pull/69' });
  assert.deepEqual(await s.live.tick(), [again], 'and so does the part that runs the contract');
});

test('the same PR number in two repos of one project (lumobot#14, new-lumo-bot#14): each is checked in its own repo', async () => {
  const s = setup({ 'lumo-bot': [part({ part: 'bot', repo: 'o/nsb' }), part({ part: 'lumobot', repo: 'o/lumobot' })] },
    { 'sha-of bot': 'bbb0001', 'sha-of lumobot': 'ddd0002' },
    { 'o/nsb': { history: { bbb0001: null }, prs: { '14': { sha: 'bbb0009', files: ['a'] } } },
      'o/lumobot': { history: { ddd0002: 'ddd0001', ddd0001: null }, prs: { '14': { sha: 'ddd0001', files: ['a'] } } } },
    { 'lumo-bot': 'o/nsb' });
  const lumobot = s.task('lumo-bot', { pr: 'https://github.com/o/lumobot/pull/14' });
  const nsb = s.task('lumo-bot', { pr: '14' });
  assert.deepEqual(await s.live.tick(), [lumobot]);
  assert.equal(s.awaiting.get(nsb)?.awaiting, 'deploy', 'new-lumo-bot#14 is not in what the bot runs');
});

test('partly deployed stays: one part of two (the ride services), and a fleet where some instances lag (canary workers)', async () => {
  const s = setup({ bot: [part({ part: 'worker', repo: 'o/bot', paths: ['worker/', 'ridematch/'] }), part({ part: 'ride-matcher', repo: 'o/bot', paths: ['ridematch/'] })] },
    { 'sha-of worker': 'f000003\nf000001', 'sha-of ride-matcher': 'f000001' },
    { 'o/bot': { history: { f000003: 'f000002', f000002: 'f000001', f000001: null },
      prs: { '371': { sha: 'f000002', files: ['ridematch/a.go'] }, '400': { sha: 'f000002', files: ['worker/a.go'] } } } },
    { bot: 'o/bot' });
  const ride = s.task('bot', { pr: '371' });
  const worker = s.task('bot', { pr: '400' });
  assert.deepEqual(await s.live.tick(), []);
  assert.equal(s.live.verdicts.get(ride)?.live, false);
  assert.deepEqual((s.live.verdicts.get(ride) as any).parts, ['worker', 'ride-matcher'], 'the worker fleet lags too');
  assert.deepEqual(s.live.verdicts.get(worker), { id: worker, live: false, why: 'behind', parts: ['worker'] }, 'one instance on f000001');
});

test('unknown is not live: a command that fails or prints no commit leaves the task, and says why', async () => {
  const s = setup({ bot: [part({ part: 'a', repo: 'o/bot' }), part({ part: 'b', repo: 'o/bot' })] },
    { 'sha-of a': new Error('ssh: connect timed out'), 'sha-of b': 'no version here' },
    { 'o/bot': { history: {}, prs: { '1': { sha: 'abc0001', files: ['x'] } } } }, { bot: 'o/bot' });
  const id = s.task('bot', { pr: '1' });
  assert.deepEqual(await s.live.tick(), []);
  assert.deepEqual(s.live.verdicts.get(id), { id, live: false, why: 'unknown', parts: ['a', 'b'] });
  const rows = s.store.db.prepare('SELECT part, shas, error FROM live_parts ORDER BY part').all() as any[];
  assert.equal(rows[0].error, 'ssh: connect timed out');
  assert.equal(rows[1].error, 'הפקודה לא החזירה commit');
});

test('what hq can\'t tell stays: no PR, a PR not merged, files no part deploys, a project with no live:', async () => {
  const s = setup({ bot: [part({ part: 'worker', repo: 'o/bot', paths: ['worker/'] })] }, { 'sha-of worker': 'abc0009' },
    { 'o/bot': { history: { abc0009: null }, prs: { '5': { sha: null, files: [] }, '6': { sha: 'abc0009', files: ['docs/a.md'] } } } }, { bot: 'o/bot' });
  const noPr = s.task('bot');
  const open = s.task('bot', { pr: '5' });
  const docs = s.task('bot', { pr: '6' });
  const other = s.task('elsewhere', { pr: '6' });
  assert.deepEqual(await s.live.tick(), []);
  assert.equal((s.live.verdicts.get(noPr) as any).why, 'no-pr');
  assert.equal((s.live.verdicts.get(open) as any).why, 'not-merged');
  assert.equal((s.live.verdicts.get(docs) as any).why, 'no-part');
  assert.equal(s.live.verdicts.has(other), false, 'no live: in its charter: nothing is run');
  assert.deepEqual(s.ran, ['sha-of worker']);
});

test('GitHub is asked once: a merged PR and an ancestry answer are kept between rounds', async () => {
  const s = setup({ bot: [part({ part: 'w', repo: 'o/bot' })] }, { 'sha-of w': 'abc0001' },
    { 'o/bot': { history: { abc0001: null }, prs: { '7': { sha: 'abc0002', files: ['x'] } } } }, { bot: 'o/bot' });
  s.task('bot', { pr: '7' });
  await s.live.tick();
  await s.live.tick();
  assert.deepEqual(s.calls, { pr: 1, contains: 1 });
});

test('backfill: a task from before v43 gets its PR\'s repo from the link its closer gave', () => {
  const s = setup({}, {}, {}, { 'lumo-bot': 'o/nsb' });
  s.awaiting.repoOf = () => null; // two checkouts: the worktree alone can't tell
  const id = Number(s.store.db.prepare(`INSERT INTO tasks (project, title, state, identity, created_at, updated_at, awaiting, awaiting_at, pr)
    VALUES ('lumo-bot', 't', 'done', 'w1', 0, 0, 'deploy', 4e12, '14')`).run().lastInsertRowid);
  const lone = Number(s.store.db.prepare(`INSERT INTO tasks (project, title, state, identity, created_at, updated_at, awaiting, awaiting_at, pr)
    VALUES ('lumo-bot', 't', 'done', 'w2', 0, 0, 'deploy', 4e12, '15')`).run().lastInsertRowid);
  const op = s.store.db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES (?, ?, 'status', ?, ?, 'ok')`);
  op.run('o1', 'w1', JSON.stringify({ state: 'done', awaiting: 'deploy', pr: 'https://github.com/o/lumobot/pull/14' }), 1000);
  op.run('o2', 'w2', JSON.stringify({ state: 'done', awaiting: 'deploy', pr: '15' }), 1000);
  assert.equal(s.awaiting.backfillPrRepos(), 1);
  assert.equal(s.awaiting.get(id)?.pr_repo, 'o/lumobot');
  assert.equal(s.awaiting.get(lone)?.pr_repo, null, 'a bare number in a project with two repos stays unknown');
});

test('a PR whose repo is unknown stays, even when the project\'s first repo has that number merged and running', async () => {
  const s = setup({ 'lumo-bot': [part({ part: 'w', repo: 'o/nsb' })] }, { 'sha-of w': 'abc0001' },
    { 'o/nsb': { history: { abc0001: 'abc0002', abc0002: null }, prs: { '14': { sha: 'abc0002', files: ['x'] } } } }, { 'lumo-bot': 'o/nsb' });
  s.awaiting.repoOf = () => null; // two checkouts: the worktree alone can't tell
  const id = s.task('lumo-bot', { pr: '14' });
  assert.equal(s.awaiting.get(id)?.pr_repo, null);
  assert.deepEqual(await s.live.tick(), []);
  assert.deepEqual(s.live.verdicts.get(id), { id, live: false, why: 'no-repo' });
  assert.equal(s.calls.pr, 0, 'GitHub is not asked about a guess');
});

test('backfill: a link given in close_team by whoever closed the team counts too', () => {
  const s = setup({}, {}, {}, {});
  s.awaiting.repoOf = () => null;
  const id = Number(s.store.db.prepare(`INSERT INTO tasks (project, title, state, identity, created_at, updated_at, awaiting, awaiting_at, pr)
    VALUES ('lumo-bot', 't', 'done', 'w1', 0, 0, 'deploy', 4e12, '14')`).run().lastInsertRowid);
  s.store.db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES ('o1', 'lead', 'close_team', ?, 1000, 'ok')`)
    .run(JSON.stringify({ team: `t${id}`, awaiting: 'deploy', pr: 'https://github.com/o/lumobot/pull/14' }));
  assert.equal(s.awaiting.backfillPrRepos(), 1);
  assert.equal(s.awaiting.get(id)?.pr_repo, 'o/lumobot');
});

test('backfill: a closed task team ran in the checkout hq opened it in (its repo: label, else the first)', () => {
  const s = setup({}, {}, {}, {});
  s.awaiting.repoOf = () => null; // the worktree is gone
  s.awaiting.checkoutsOf = () => [{ name: 'agent-company', repo: 'o/engine' }, { name: 'my-company', repo: 'o/company' }];
  const add = (identity: string, labels: string[]) => {
    const id = Number(s.store.db.prepare(`INSERT INTO tasks (project, title, state, identity, labels, created_at, updated_at, awaiting, awaiting_at, pr)
      VALUES ('agent-company', 't', 'done', ?, ?, 0, 0, 'deploy', 4e12, '9')`).run(identity, JSON.stringify(labels)).lastInsertRowid);
    if (identity === 'team') s.store.db.prepare('UPDATE tasks SET identity = ? WHERE id = ?').run(`agent-company-t${id}`, id);
    return id;
  };
  const first = add('team', []), labelled = add('team', ['repo:my-company']), standing = add('ron', []), standingLabelled = add('ron', ['repo:my-company']);
  assert.equal(s.awaiting.backfillPrRepos(), 3);
  assert.equal(s.awaiting.get(first)?.pr_repo, 'o/engine');
  assert.equal(s.awaiting.get(labelled)?.pr_repo, 'o/company');
  assert.equal(s.awaiting.get(standingLabelled)?.pr_repo, 'o/company');
  assert.equal(s.awaiting.get(standing)?.pr_repo, null, 'a standing worker works wherever: no guess');
});

test('mark: a bare PR number takes the repo of the PR its own shift created', () => {
  const s = setup({}, {}, {});
  s.awaiting.prLinksOf = () => ['https://github.com/o/tinode/pull/355', 'https://github.com/o/app/pull/4327'];
  const id = s.task('lumo', { pr: '355' });
  assert.equal(s.awaiting.get(id)?.pr_repo, 'o/tinode');
});

test('a store release (sha: report): unknown until a deploy report names the part, so an app + server PR waits for both', async () => {
  const s = setup({ apps: [part({ part: 'server', repo: 'o/apps', paths: ['server/'] }), { part: 'android', repo: 'o/apps', paths: ['apps/'], sha: null }] },
    { 'sha-of server': 'a000002' },
    { 'o/apps': { history: { a000002: 'a000001', a000001: null }, prs: { '33': { sha: 'a000001', files: ['server/x.dart', 'apps/slot/lib/a.dart'] } } } },
    { apps: 'o/apps' });
  const id = s.task('apps', { pr: '33' });
  assert.deepEqual(await s.live.tick(), [], 'the server runs it; the store release is not known yet');
  assert.deepEqual(s.live.verdicts.get(id), { id, live: false, why: 'unknown', parts: ['android'] });
  assert.deepEqual(s.ran, ['sha-of server'], 'no command for a report part');
  s.awaiting.deployed({ project: 'apps', sha: 'a000002', target: 'android' });
  assert.deepEqual(await s.live.refresh('apps'), [id]);
});

test('one round at a time: a refresh during a tick waits for it, so a part\'s command never runs twice at once', async () => {
  const store = new Store(':memory:');
  const awaiting = new AwaitingBoard(store);
  awaiting.repoOf = () => 'o/bot';
  let now = 0, most = 0;
  const live = new LiveWatch(store, awaiting, () => [part({ part: 'w', repo: 'o/bot' })], {
    git: fakeGit({ 'o/bot': { history: { abc0001: null }, prs: { '7': { sha: null, files: [] } } } }).git,
    run: async () => { most = Math.max(most, ++now); await new Promise((r) => setTimeout(r, 20)); now--; return 'abc0001'; },
  });
  const id = Number(store.db.prepare(`INSERT INTO tasks (project, title, state, created_at, updated_at) VALUES ('bot', 't', 'done', 0, 0)`).run().lastInsertRowid);
  awaiting.mark(id, { awaiting: 'deploy', pr: '7' }, 'w');
  await Promise.all([live.tick(), live.refresh('bot'), live.tick()]);
  assert.equal(most, 1);
});
