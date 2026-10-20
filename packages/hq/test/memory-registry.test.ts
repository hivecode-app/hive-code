// Registries (open-*.md, *-actions.md, customers.md) land on main at once, through one queue, with the guard:
// fresh main before every commit, replace checked against base_sha, the path in the writer's project, no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { git, makeEnv, ORG_YAML, repo, type TestEnv } from './helpers.ts';
import { type Run } from '../src/memory-files.ts';
import { blobSha, CONFLICTS_TO_OWNER, markdownProblem, registryProject, secretIn, TRAILER } from '../src/memory-registry.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const exec: Run = (cmd, args, cwd) => new Promise((res, rej) =>
  execFile(cmd, args, { cwd, env: GIT_ENV }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));

// Two workers of agent-company (ac-ceo and ac-dev) and one of another project (sb-dev, lumo-bot).
const ORG = ORG_YAML.replace('members: []}\nidentities:', 'members: [ac-dev]}\n  - {id: lumo-bot, kind: project, project: lumo-bot, symbol: domain, lead: sb-dev, members: []}\nidentities:')
  + '  - {id: ac-dev, name: עידו, title: מפתח, symbol: build, team: agent-company, reports_to: ac-ceo, kind: project, lifecycle: dormant}\n'
  + '  - {id: sb-dev, name: רון, title: מפתח, symbol: build, team: lumo-bot, reports_to: yoav, kind: project, lifecycle: dormant}\n';

const OPEN = 'memory/projects/agent-company/open-ac.md';
const LOG = 'memory/projects/agent-company/ac-actions.md';

const entry = (args: Record<string, unknown>, id: string, identity: string): WalEntry =>
  ({ id, v: 1, ts: new Date().toISOString(), identity, shift: `${identity}-1`, sessionId: null, op: 'remember', args });

async function setup(run?: (base: Run, r: ReturnType<typeof repo>) => Run) {
  const r = repo();
  mkdirSync(join(r.checkout, 'memory', 'projects', 'agent-company'), { recursive: true });
  writeFileSync(join(r.checkout, 'memory', 'projects', 'agent-company', 'INDEX.md'), '# agent-company\n');
  writeFileSync(join(r.checkout, OPEN), '# מה פתוח\n');
  writeFileSync(join(r.checkout, LOG), '# יומן\n');
  git(r.checkout, 'add', '.'); git(r.checkout, 'commit', '--quiet', '-m', 'mem'); git(r.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
  const env = await makeEnv({ org: ORG });
  const { hq } = env;
  const gh: string[][] = [];
  const base: Run = async (cmd, args, cwd) => { if (cmd === 'gh') { gh.push(args); return ''; } return exec(cmd, args, cwd); };
  hq.memoryFiles.run = run ? run(base, r) : base;
  hq.memoryFiles.repoDir = r.checkout;
  hq.store.setToggle('adi/memory-files', true, false);
  const add = (id: string, identity: string, file: string, text: string, extra: Record<string, unknown> = {}) =>
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', project: 'agent-company', file, text, ...extra }, id, identity));
  const main = (file: string) => { git(r.checkout, 'fetch', '--quiet', 'origin'); return git(r.checkout, 'show', `origin/main:${file}`); };
  const done = async () => { await env.cleanup(); r.cleanup(); };
  return { r, env, hq, gh, add, main, done };
}

const untouched = (env: TestEnv, r: ReturnType<typeof repo>) => {
  assert.equal(git(r.checkout, 'status', '--porcelain'), '', 'the main checkout stays clean');
  assert.equal(git(r.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(r.checkout, 'worktree', 'list').split('\n').length, 1, 'the temp worktree is gone');
  void env;
};

test('registryProject: the closed list, by name', () => {
  assert.equal(registryProject('memory/projects/lumo-bot/open-ron.md'), 'lumo-bot');
  assert.equal(registryProject('memory/projects/lumo-bot/michal-actions.md'), 'lumo-bot');
  assert.equal(registryProject('memory/projects/lumo-bot/customers.md'), 'lumo-bot');
  for (const no of ['memory/projects/lumo-bot/decisions.md', 'memory/projects/lumo-bot/lessons.md', 'memory/open-ron.md',
    'memory/projects/lumo-bot/sub/open-x.md', 'memory/company/customers.md']) assert.equal(registryProject(no), null, no);
});

test('secretIn: tokens, keys and passwords; ordinary notes pass', () => {
  for (const s of ['ghp_' + 'a'.repeat(36), 'github_pat_' + 'A1'.repeat(20), 'sk-ant-api03-' + 'x'.repeat(30), 'AKIA' + 'ABCDEFGHIJKLMNOP',
    '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', 'password: hunter2hunter2', 'DICTATE_TOKEN=abcdef0123456789', 'סיסמה: 12345678',
    'secret_key = "abcd1234efgh5678"', 'AWS_SECRET_ACCESS_KEY=wJalr' + 'XUtnFEMI/K7MDENG/bPxRfiCY', 'private_key: MIIEvQIBADAN8gkqh9w',
    'Authorization: Bearer abcdefghijklmnop0123456789', 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']) assert.ok(secretIn(s), s);
  for (const s of ['- 21/10 הארכת מנוי לתחנה 12, 300 ₪', 'הטוקן שמור ב-`~/.config/agent-company/hq.env`', 'token: `<redacted>`',
    'PR #43 מוזג, ה-image `sha256:ccd7b8ba` נדחף', 'controller 1.7.23',
    'token: GITHUB_TOKEN', 'api_key: process.env.X', 'secret: ~/.config/company/hq.env', 'סיסמה: בכספת', 'token: עדיין-לא-הוגדר', 'max_tokens: 4096',
    'input_tokens: 123456789', 'max_tokens=200000000', 'token_count: 1234567890']) assert.equal(secretIn(s), null, s);
});

test('markdownProblem: a link to nothing or an open code fence would break check:contract', () => {
  const exists = (rel: string) => ['memory/projects/x/INDEX.md', 'company/org.yaml'].includes(rel);
  assert.equal(markdownProblem('memory/projects/x/open-a.md', '# א\n[אינדקס](INDEX.md) [org](../../../company/org.yaml) [אתר](https://x.y) `[a](nope.md)`\n', exists), null);
  assert.match(markdownProblem('memory/projects/x/open-a.md', '[שבור](nope.md)\n', exists)!, /לא קיים/);
  assert.match(markdownProblem('memory/projects/x/open-a.md', '```\nקוד\n', exists)!, /לא נסגר/);
});

test('ingest: a registry outside your project, a project without a folder, or a secret is refused at the door', async () => {
  const { hq, add, done } = await setup();
  try {
    // Another project's registry: refused, with the reason in Hebrew in the sender's mailbox.
    assert.throws(() => add('x:1', 'sb-dev', OPEN, '- שורה'), /not a registry sb-dev may write/);
    assert.match(hq.mailbox.get('x:1-rejected')!.body, /הפרויקט שלך הוא `lumo-bot`/);
    // No project at all (eli is in the personal team).
    assert.throws(() => add('x:2', 'eli', OPEN, '- שורה'), /not a registry eli may write/);
    // sb-dev's own project, but memory/projects/lumo-bot/ has no INDEX.md in the checkout.
    assert.throws(() => add('x:3', 'sb-dev', 'memory/projects/lumo-bot/open-ron.md', '- שורה'), /not a registry/);
    assert.match(hq.mailbox.get('x:3-rejected')!.body, /INDEX\.md/);
    // A secret, in a registry or in a file for the PR.
    assert.throws(() => add('x:4', 'ac-dev', LOG, `- הטוקן: ghp_${'a'.repeat(36)}`), /looks like a secret \(GitHub token\)/);
    assert.throws(() => add('x:5', 'ac-dev', 'memory/projects/agent-company/lessons.md', 'password=supersecret1'), /looks like a secret/);
    assert.match(hq.mailbox.get('x:5-rejected')!.body, /נראה כמו סוד/);
    assert.throws(() => add('x:6', 'ac-dev', OPEN, 'x', { mode: 'replace', base_sha: 'nothex' }), /base_sha/);
    // Nothing of it waits anywhere; a lessons file still goes to the PR, not to main.
    add('x:7', 'ac-dev', 'memory/projects/agent-company/lessons.md', '- לקח');
    assert.deepEqual(hq.memoryFiles.registry.pending(), []);
    assert.deepEqual(hq.memoryFiles.pending().map((p) => p.id), ['x:7']);
  } finally { await done(); }
});

test('two workers append to the same registry at once: both lines land, one commit each, the checkout untouched', async () => {
  const { r, env, hq, gh, add, main, done } = await setup();
  try {
    const a = add('a:1', 'ac-ceo', LOG, '- 21/10 שירה: פתחה צוות');
    const b = add('b:1', 'ac-dev', LOG, '- 21/10 עידו: מיזג PR');
    assert.equal((a.result as { commit?: string }).commit, 'queued');
    assert.equal((b.result as { commit?: string }).commit, 'queued');
    // The ingest kicked the queue; both kicks share the one drain.
    await Promise.all([hq.memoryFiles.registry.kick(), hq.memoryFiles.registry.kick()]);
    assert.equal(main(LOG), '# יומן\n- 21/10 שירה: פתחה צוות\n- 21/10 עידו: מיזג PR');
    const log = git(r.checkout, 'log', '--format=%B%x00', 'origin/main', '-n', '2').split('\0').map((s) => s.trim()).filter(Boolean);
    assert.equal(log.length, 2);
    assert.match(log[0]!, new RegExp(`${TRAILER}: b:1$`));
    assert.match(log[1]!, new RegExp(`${TRAILER}: a:1$`));
    // The journal: who, what, the sha on main.
    const events = (hq.store.db.prepare(`SELECT identity, data FROM events WHERE type = 'memory_files.registry' ORDER BY seq`).all() as
      { identity: string; data: string }[]).map((e): Record<string, unknown> => ({ ...JSON.parse(e.data) as Record<string, unknown>, identity: e.identity }));
    assert.deepEqual(events.map((e) => e.identity), ['ac-ceo', 'ac-dev']);
    assert.deepEqual(events.map((e) => [e.op, e.file, e.outcome]), [['a:1', LOG, 'committed'], ['b:1', LOG, 'committed']]);
    assert.equal(events[1]!.sha, git(r.checkout, 'rev-parse', 'origin/main'));
    assert.deepEqual(hq.memoryFiles.registry.pending(), []);
    assert.deepEqual(gh, [], 'no PR');
    untouched(env, r);
    assert.equal(readFileSync(join(r.checkout, LOG), 'utf8'), '# יומן\n', 'the checkout gets it only at the next deploy');
  } finally { await done(); }
});

test('append while main moved under the queue: the push loses the race, and the write goes again on top', async () => {
  let raced = false;
  const { r, add, main, hq, done } = await setup((base, rr) => async (cmd, args, cwd) => {
    // Someone merges to main between our fetch and our push, once.
    if (cmd === 'git' && args[0] === 'push' && args.includes('HEAD:refs/heads/main') && !raced) {
      raced = true;
      writeFileSync(join(rr.checkout, LOG), '# יומן\n- ממיזוג אחר\n');
      git(rr.checkout, 'commit', '--quiet', '-am', 'other (#9)'); git(rr.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
    }
    return base(cmd, args, cwd);
  });
  try {
    add('c:1', 'ac-dev', LOG, '- שלי');
    await hq.memoryFiles.registry.kick();
    assert.ok(raced);
    assert.equal(main(LOG), '# יומן\n- ממיזוג אחר\n- שלי');
    void r;
  } finally { await done(); }
});

test('replace with a stale base_sha fails, the worker gets the new text, and the retry with the new sha lands', async () => {
  const { r, env, hq, add, main, done } = await setup();
  try {
    // Both read the same version through recall: it hands out base_sha.
    const read = await hq.ingest.recallWithFiles({ identity: 'ac-dev', shift: 'ac-dev-1', query: OPEN });
    assert.equal(read.items[0]!.text, '# מה פתוח\n');
    const sha = read.items[0]!.base_sha!;
    assert.equal(sha, git(r.checkout, 'rev-parse', `origin/main:${OPEN}`), 'git\'s own blob id');
    add('r:1', 'ac-ceo', OPEN, '# מה פתוח\n\n- של שירה', { mode: 'replace', base_sha: sha });
    add('r:2', 'ac-dev', OPEN, '# מה פתוח\n\n- של עידו', { mode: 'replace', base_sha: sha });
    await hq.memoryFiles.registry.kick();
    assert.equal(main(OPEN), '# מה פתוח\n\n- של שירה', 'the first one wins, the second does not erase it');
    const note = hq.mailbox.get('r:2-conflict')!;
    assert.equal(note.to_identity, 'ac-dev');
    assert.match(note.body, /השתנה מאז שקראת אותו/);
    assert.match(note.body, /- של שירה/, 'with the text as it is now');
    const fresh = blobSha('# מה פתוח\n\n- של שירה\n');
    assert.match(note.body, new RegExp(`base_sha: "${fresh}"`));
    // The retry on the new version.
    add('r:3', 'ac-dev', OPEN, '# מה פתוח\n\n- של שירה\n- של עידו', { mode: 'replace', base_sha: fresh });
    await hq.memoryFiles.registry.kick();
    assert.equal(main(OPEN), '# מה פתוח\n\n- של שירה\n- של עידו');
    // A replace with no base_sha on a file that exists: the same, it did not read first.
    add('r:4', 'ac-dev', OPEN, 'הכול מחדש', { mode: 'replace' });
    await hq.memoryFiles.registry.kick();
    assert.match(hq.mailbox.get('r:4-conflict')!.body, /לא צירפת `base_sha`/);
    assert.equal(main(OPEN), '# מה פתוח\n\n- של שירה\n- של עידו');
    untouched(env, r);
  } finally { await done(); }
});

test('three conflicts in a row go to the owner of the automation (adi), not to Ran', async () => {
  const { hq, add, done } = await setup();
  try {
    for (let i = 1; i <= CONFLICTS_TO_OWNER; i++) {
      add(`s:${i}`, 'ac-dev', OPEN, `ניסיון ${i}`, { mode: 'replace', base_sha: '0'.repeat(40) });
      await hq.memoryFiles.registry.kick();
    }
    const owner = hq.store.db.prepare(`SELECT to_identity, body FROM messages WHERE id LIKE 'memory-files-registry-conflict-%'`).all() as { to_identity: string; body: string }[];
    assert.equal(owner.length, 1);
    assert.equal(owner[0]!.to_identity, 'adi');
    assert.match(owner[0]!.body, /3 פעמים ברצף/);
    assert.match(hq.mailbox.get(`s:${CONFLICTS_TO_OWNER}-conflict`)!.body, /לא לנסות שוב/);
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE to_identity = 'owner'`).get() as { n: number }).n, 0);
  } finally { await done(); }
});

test('a write that would break check:contract does not land; the worker hears why', async () => {
  const { hq, add, main, done } = await setup();
  try {
    add('m:1', 'ac-dev', LOG, '- ראו [כאן](nope.md)');
    await hq.memoryFiles.registry.kick();
    assert.match(hq.mailbox.get('m:1-invalid')!.body, /מצביע על קובץ שלא קיים/);
    assert.equal(main(LOG), '# יומן');
  } finally { await done(); }
});

test('a push that keeps failing leaves the write waiting; the owner hears once; the sweep sends it later', async () => {
  let down = true;
  const { hq, add, main, done } = await setup((base) => async (cmd, args, cwd) => {
    if (down && cmd === 'git' && args[0] === 'push') throw new Error('git push: network is down');
    return base(cmd, args, cwd);
  });
  try {
    add('f:1', 'ac-dev', LOG, '- מחכה');
    for (let i = 0; i < 4; i++) await hq.memoryFiles.registry.kick().catch(() => {});
    // Once, after the first write that used up its attempts; not again for every round that follows.
    assert.deepEqual(hq.memoryFiles.registry.pending().map((o) => o.id), ['f:1']);
    const notes = hq.store.db.prepare(`SELECT to_identity FROM messages WHERE id LIKE 'memory-files-registry-fail-%'`).all() as { to_identity: string }[];
    assert.deepEqual(notes, [{ to_identity: 'adi' }]);
    down = false;
    await hq.memoryFiles.sweep();
    assert.equal(main(LOG), '# יומן\n- מחכה');
    assert.deepEqual(hq.memoryFiles.registry.pending(), []);
  } finally { await done(); }
});

test('a write already on main (hq stopped between push and marking) is marked, not written twice', async () => {
  const { r, hq, add, main, done } = await setup();
  try {
    add('d:1', 'ac-dev', LOG, '- פעם אחת');
    await hq.memoryFiles.registry.kick();
    hq.store.db.prepare(`DELETE FROM memory_file_ops WHERE op_id = 'd:1'`).run();
    await hq.memoryFiles.registry.kick();
    assert.equal(main(LOG), '# יומן\n- פעם אחת');
    assert.equal(git(r.checkout, 'rev-list', '--count', 'origin/main'), '3');
  } finally { await done(); }
});

test('a `registry` flag from the client is ignored: routing is the ingest\'s alone, and write() checks again', async () => {
  const { hq, add, main, done } = await setup();
  try {
    add('g:1', 'ac-dev', 'memory/projects/agent-company/decisions.md', '- החלטה', { registry: true });
    assert.deepEqual(hq.memoryFiles.registry.pending(), []);
    assert.deepEqual(hq.memoryFiles.pending().map((p) => p.id), ['g:1'], 'to the PR, for review');
    // Even if such a row is in the store (an older hq, a hand edit), the queue does not commit it.
    hq.store.db.prepare(`UPDATE ops SET args = json_set(args, '$.registry', json('true')) WHERE id = 'g:1'`).run();
    await hq.memoryFiles.registry.kick();
    assert.match(hq.mailbox.get('g:1-invalid')!.body, /זה לא רישום/);
    assert.throws(() => main('memory/projects/agent-company/decisions.md'));
  } finally { await done(); }
});

test('a write that arrives while the queue is finishing is not left for the sweep', async () => {
  let late: (() => void) | null = null;
  const { hq, add, main, done } = await setup((base) => async (cmd, args, cwd) => {
    // The moment the drain removes its worktree (done with everything), another worker writes.
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove' && late) { const f = late; late = null; f(); }
    return base(cmd, args, cwd);
  });
  try {
    late = () => { add('l:2', 'ac-ceo', LOG, '- מאוחר'); };
    add('l:1', 'ac-dev', LOG, '- ראשון');
    // The kick from l:2's ingest got the drain in flight; that drain goes again by itself, before it settles.
    await hq.memoryFiles.registry.kick();
    assert.equal(main(LOG), '# יומן\n- ראשון\n- מאוחר');
    assert.deepEqual(hq.memoryFiles.registry.pending(), []);
  } finally { await done(); }
});
