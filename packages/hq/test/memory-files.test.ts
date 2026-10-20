// #115: `remember` with `file` → stored at once, then folded into one rolling PR from a temp worktree, never the checkout.
// (Registries skip the PR: memory-registry.test.ts. The files here are the ones that still go through review.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { git, makeEnv, repo } from './helpers.ts';
import { applyUpdate, BRANCH, FLUSH_AGE_MS, memoryFilePath, type Run } from '../src/memory-files.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const entry = (args: Record<string, unknown>, id: string, identity = 'eli'): WalEntry =>
  ({ id, v: 1, ts: new Date().toISOString(), identity, shift: `${identity}-1`, sessionId: null, op: 'remember', args });

test('memoryFilePath: only .md under memory/, normalized, no escape', () => {
  assert.equal(memoryFilePath('memory/projects/lumo-bot/open-ron.md'), 'memory/projects/lumo-bot/open-ron.md');
  assert.equal(memoryFilePath('./memory/a//b.md'), 'memory/a/b.md');
  for (const bad of ['memory/../company/org.yaml', '../memory/a.md', '/home/u/memory/a.md', 'company/identities/ron.md',
    'memory/a.txt', 'memory/a b.md', 'memory/x/../../etc.md', '', 7, undefined]) assert.equal(memoryFilePath(bad), null, String(bad));
});

test('applyUpdate: append keeps the file and adds a line, replace swaps it', () => {
  assert.equal(applyUpdate('# יומן\n', '- 20/10 שורה', 'append'), '# יומן\n- 20/10 שורה\n');
  assert.equal(applyUpdate('# יומן', 'שורה\n', 'append'), '# יומן\nשורה\n');
  assert.equal(applyUpdate(null, 'חדש', 'append'), 'חדש\n');
  assert.equal(applyUpdate('ישן\n', '# חדש\n\nתוכן', 'replace'), '# חדש\n\nתוכן\n');
});

test('ingest: remember with file is validated and stored with the normalized path', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    assert.equal((hq.ingest.op(entry({ scope: 'project', kind: 'fact', text: 'x', file: './memory/a.md' }, 'eli-1:m1')).result as { file?: string }).file, 'memory/a.md');
    assert.equal(hq.memoryFiles.pending()[0]!.file, 'memory/a.md');
    assert.equal(hq.memoryFiles.pending()[0]!.mode, 'append');
    assert.throws(() => hq.ingest.op(entry({ scope: 'project', kind: 'fact', text: 'x', file: 'company/org.yaml' }, 'eli-1:m2')), /memory\/<path>\.md/);
    assert.throws(() => hq.ingest.op(entry({ scope: 'project', kind: 'fact', text: 'x', file: 'memory/a.md', mode: 'prepend' }, 'eli-1:m3')), /append or replace/);
    assert.throws(() => hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/a.md' }, 'eli-1:m4')), /text is required/);
    // The rejection reaches the sender in Hebrew.
    assert.match(hq.mailbox.get('eli-1:m2-rejected')!.body, /תחת `memory\/`/);
    // A plain remember is untouched and never pending.
    hq.ingest.op(entry({ scope: 'company', kind: 'lesson', text: 'בלי קובץ' }, 'eli-1:m5'));
    assert.equal(hq.memoryFiles.pending().length, 1);
  } finally { await env.cleanup(); }
});

test('flush: one rolling PR from a temp worktree, more commits while it is open, a fresh branch after merge', async () => {
  const r = repo();
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    mkdirSync(join(r.checkout, 'memory', 'projects', 'lumo-bot'), { recursive: true });
    writeFileSync(join(r.checkout, 'memory', 'projects', 'lumo-bot', 'lessons.md'), '# יומן\n');
    git(r.checkout, 'add', '.'); git(r.checkout, 'commit', '--quiet', '-m', 'mem'); git(r.checkout, 'push', '--quiet', 'origin', 'HEAD:main');

    let prOpen: string | null = null;
    const gh: string[][] = [];
    const run: Run = async (cmd, args, cwd) => {
      if (cmd === 'gh') {
        gh.push(args);
        if (args[1] === 'list') return prOpen ?? '';
        prOpen = 'https://github.com/hivecode-app/hive-code/pull/200';
        return prOpen;
      }
      return new Promise((res, rej) => execFile(cmd, args, { cwd, env: GIT_ENV }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out.trim()))));
    };
    hq.memoryFiles.run = run;
    hq.memoryFiles.repoDir = r.checkout;
    hq.store.setToggle('adi/memory-files', true, false);

    const add = (id: string, file: string, text: string, mode?: string) =>
      hq.ingest.op(entry({ scope: 'project', kind: 'fact', project: 'lumo-bot', file, text, ...(mode ? { mode } : {}) }, id, 'eli'));
    add('e:1', 'memory/projects/lumo-bot/lessons.md', '- 20/10 הארכת מנוי לתחנה 12');
    add('e:2', 'memory/projects/lumo-bot/decisions.md', '# מה פתוח אצל מיכל\n\nכלום', 'replace');
    add('e:3', 'memory/projects/lumo-bot/lessons.md', '- 20/10 זיכוי ללקוח');

    assert.equal(hq.memoryFiles.due(), false, 'three updates, a minute old: not yet');
    clock.advance(FLUSH_AGE_MS);
    assert.equal(hq.memoryFiles.due(), true, 'the oldest waited an hour');
    await hq.memoryFiles.sweep();

    const show = (path: string) => git(r.checkout, 'show', `origin/${BRANCH}:${path}`);
    git(r.checkout, 'fetch', '--quiet', 'origin');
    assert.equal(show('memory/projects/lumo-bot/lessons.md'), '# יומן\n- 20/10 הארכת מנוי לתחנה 12\n- 20/10 זיכוי ללקוח');
    assert.equal(show('memory/projects/lumo-bot/decisions.md'), '# מה פתוח אצל מיכל\n\nכלום');
    assert.equal(gh.filter((a) => a[1] === 'create').length, 1);
    assert.equal(hq.memoryFiles.pending().length, 0);
    assert.match(hq.mailbox.get('memory-files-e:1')!.body, /pull\/200/);
    assert.equal(hq.mailbox.get('memory-files-e:1')!.to_identity, 'adi');
    // The checkout hq runs from is untouched: no file, no branch switch, no dirty tree.
    assert.equal(git(r.checkout, 'status', '--porcelain'), '');
    assert.equal(git(r.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(readFileSync(join(r.checkout, 'memory', 'projects', 'lumo-bot', 'lessons.md'), 'utf8'), '# יומן\n');
    assert.equal(git(r.checkout, 'worktree', 'list').split('\n').length, 1);

    // Reading before a replace: the open PR's branch plus what still waits, through recall with the path.
    add('e:3b', 'memory/projects/lumo-bot/lessons.md', '- 20/10 עוד אחת', 'append');
    const seen = await hq.ingest.recallWithFiles({ identity: 'eli', shift: 'eli-1', query: 'memory/projects/lumo-bot/lessons.md' });
    assert.equal(seen.items[0]!.ref, 'memory/projects/lumo-bot/lessons.md');
    assert.equal(seen.items[0]!.text, '# יומן\n- 20/10 הארכת מנוי לתחנה 12\n- 20/10 זיכוי ללקוח\n- 20/10 עוד אחת\n');
    assert.equal(await hq.memoryFiles.current('memory/projects/none.md'), null);
    await hq.memoryFiles.flush();

    // PR still open: the next update is another commit on the same branch, no second PR.
    add('e:4', 'memory/projects/lumo-bot/lessons.md', '- 21/10 עוד פעולה');
    await hq.memoryFiles.flush();
    git(r.checkout, 'fetch', '--quiet', 'origin');
    assert.match(show('memory/projects/lumo-bot/lessons.md'), /עוד אחת\n- 21\/10 עוד פעולה$/);
    assert.equal(gh.filter((a) => a[1] === 'create').length, 1);
    assert.match(hq.mailbox.get('memory-files-e:4')!.body, /^נוספו 1/);

    // main moves under the open PR (another file): the branch takes main in, and stays mergeable.
    writeFileSync(join(r.checkout, 'memory', 'other.md'), 'מ-main\n');
    git(r.checkout, 'add', '.'); git(r.checkout, 'commit', '--quiet', '-m', 'other'); git(r.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
    add('e:4b', 'memory/projects/lumo-bot/lessons.md', '- 21/10 אחרי main');
    await hq.memoryFiles.flush();
    git(r.checkout, 'fetch', '--quiet', 'origin');
    assert.equal(show('memory/other.md'), 'מ-main');
    assert.equal(git(r.checkout, 'merge-base', '--is-ancestor', 'origin/main', `origin/${BRANCH}`), '');

    // Merged (squash) and closed: the branch starts again from main, which already has the merged content.
    git(r.checkout, 'merge', '--quiet', '--squash', `origin/${BRANCH}`);
    git(r.checkout, 'commit', '--quiet', '-m', 'squash'); git(r.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
    prOpen = null;
    add('e:5', 'memory/projects/lumo-bot/decisions.md', '# מה פתוח אצל מיכל\n\nזיכוי לתחנה 3', 'replace');
    await hq.memoryFiles.flush();
    git(r.checkout, 'fetch', '--quiet', 'origin');
    assert.equal(gh.filter((a) => a[1] === 'create').length, 2);
    assert.equal(git(r.checkout, 'rev-list', '--count', `origin/main..origin/${BRANCH}`), '1');
    assert.equal(show('memory/projects/lumo-bot/decisions.md'), '# מה פתוח אצל מיכל\n\nזיכוי לתחנה 3');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('sweep does nothing while the automation is off, and a failed push keeps the updates pending', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const calls: string[] = [];
    hq.memoryFiles.run = async (cmd, args) => { calls.push(`${cmd} ${args[0]}`); throw new Error('no network'); };
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', text: 'x', file: 'memory/a.md' }, 'eli-1:f1'));
    clock.advance(FLUSH_AGE_MS);
    await hq.memoryFiles.sweep();
    assert.deepEqual(calls, [], 'no memory-files automation in this org.yaml → off');
    hq.store.setToggle('adi/memory-files', true, false);
    await assert.rejects(hq.memoryFiles.sweep(), /no network/);
    assert.equal(hq.memoryFiles.pending().length, 1);
  } finally { await env.cleanup(); }
});

test('a company home without memory/ (no COMPANY_HOME: the engine, since the split) gets nothing, the updates wait', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const calls: string[] = [];
    hq.memoryFiles.run = async (cmd, args) => { calls.push(`${cmd} ${args[0]}`); return ''; };
    hq.store.setToggle('adi/memory-files', true, false);
    hq.memoryFiles.repoDir = join(hq.memoryFiles.repoDir, 'no-company-here');
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', text: 'x', file: 'memory/a.md' }, 'eli-1:g1'));
    clock.advance(FLUSH_AGE_MS);
    await hq.memoryFiles.sweep();
    assert.deepEqual(calls, []);
    assert.equal(hq.memoryFiles.enabled(), false);
    assert.equal(hq.memoryFiles.pending().length, 1);
  } finally { await env.cleanup(); }
});

test('flush: a conflict with main keeps the updates pending and tells the owner; nothing is applied twice', async () => {
  const r = repo();
  const env = await makeEnv();
  try {
    const { hq } = env;
    let prOpen: string | null = null;
    hq.memoryFiles.run = async (cmd, args, cwd) => {
      if (cmd === 'gh') { if (args[1] === 'list') return prOpen ?? ''; prOpen = 'https://x/pull/7'; return `${prOpen}\n`; }
      return new Promise((res, rej) => execFile(cmd, args, { cwd, env: GIT_ENV }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
    };
    hq.memoryFiles.repoDir = r.checkout;
    hq.store.setToggle('adi/memory-files', true, false);
    const add = (id: string, text: string, mode = 'replace') =>
      hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/open.md', text, mode }, id));
    add('c:1', 'מה-PR');
    assert.equal(await hq.memoryFiles.flush(), 'https://x/pull/7');
    // main changes the same file another way: the open branch can't take it in.
    mkdirSync(join(r.checkout, 'memory'), { recursive: true });
    writeFileSync(join(r.checkout, 'memory', 'open.md'), 'מ-main\n');
    git(r.checkout, 'add', '.'); git(r.checkout, 'commit', '--quiet', '-m', 'x'); git(r.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
    add('c:2', 'עוד');
    await assert.rejects(hq.memoryFiles.flush(), /conflicts with main/);
    assert.equal(hq.memoryFiles.pending().length, 1);
    assert.match(hq.mailbox.get('memory-files-conflict-c:2')!.body, /מתנגש עם main/);
    assert.equal(git(r.checkout, 'worktree', 'list').split('\n').length, 1, 'the temp worktree is gone');
    assert.equal(git(r.checkout, 'status', '--porcelain'), '');

    // Already on the branch (a crash before marking): marked, not applied again.
    const r2 = repo();
    try {
      hq.memoryFiles.repoDir = r2.checkout; prOpen = null;
      hq.store.db.prepare(`DELETE FROM memory_file_ops`).run();
      hq.store.db.prepare(`DELETE FROM ops WHERE id = 'c:2'`).run();
      hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/log.md', text: '- שורה' }, 'c:1x'));
      hq.store.db.prepare(`DELETE FROM ops WHERE id = 'c:1'`).run();
      await hq.memoryFiles.flush();
      hq.store.db.prepare(`DELETE FROM memory_file_ops`).run();
      assert.equal(hq.memoryFiles.pending().length, 1);
      await hq.memoryFiles.flush();
      git(r2.checkout, 'fetch', '--quiet', 'origin');
      assert.equal(git(r2.checkout, 'show', `origin/${BRANCH}:memory/log.md`), '- שורה');
      assert.equal(hq.memoryFiles.pending().length, 0);
    } finally { r2.cleanup(); }
  } finally { await env.cleanup(); r.cleanup(); }
});

test('flush: merged between the look and the push → a new PR, not a lost commit', async () => {
  const r = repo();
  const env = await makeEnv();
  try {
    const { hq } = env;
    let lists = 0; let created = 0;
    hq.memoryFiles.run = async (cmd, args, cwd) => {
      if (cmd === 'gh') {
        if (args[1] === 'list') return ++lists === 2 ? 'https://x/pull/1' : '';
        created++; return 'https://x/pull/2';
      }
      return new Promise((res, rej) => execFile(cmd, args, { cwd, env: GIT_ENV }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
    };
    hq.memoryFiles.repoDir = r.checkout;
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/a.md', text: 'א' }, 'k:1'));
    await hq.memoryFiles.flush(); // list #1: none → new PR (create #1)
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/a.md', text: 'ב' }, 'k:2'));
    const url = await hq.memoryFiles.flush(); // list #2: open; list #3 after push: gone → create #2
    assert.equal(created, 2);
    assert.equal(url, 'https://x/pull/2');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('sweep: the owner hears once after repeated failures', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.memoryFiles.run = async () => { throw new Error('gh: auth'); };
    hq.store.setToggle('adi/memory-files', true, false);
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', text: 'x', file: 'memory/a.md' }, 'z:1'));
    clock.advance(FLUSH_AGE_MS);
    for (let i = 0; i < 5; i++) await hq.memoryFiles.sweep().catch(() => {});
    const notes = hq.store.db.prepare(`SELECT body FROM messages WHERE id LIKE 'memory-files-fail-%'`).all() as { body: string }[];
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.body, /gh: auth/);
  } finally { await env.cleanup(); }
});

test('current: what landed on main after the last flush is read too, with the PR open and after it merged', async () => {
  const r = repo();
  const env = await makeEnv();
  try {
    const { hq } = env;
    let prOpen: string | null = null;
    hq.memoryFiles.run = async (cmd, args, cwd) => {
      if (cmd === 'gh') { if (args[1] === 'list') return prOpen ?? ''; prOpen = 'https://x/pull/9'; return prOpen; }
      return new Promise((res, rej) => execFile(cmd, args, { cwd, env: GIT_ENV }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
    };
    hq.memoryFiles.repoDir = r.checkout;
    // Another clone stands for a PR from a worktree (like #116) that lands on main while hq isn't looking.
    const other = join(r.dir, 'other');
    git(r.dir, 'clone', '--quiet', join(r.dir, 'origin.git'), other);
    const land = (file: string, text: string) => {
      git(other, 'pull', '--quiet', 'origin', 'main');
      mkdirSync(join(other, 'memory'), { recursive: true });
      writeFileSync(join(other, file), text);
      git(other, 'add', '.'); git(other, 'commit', '--quiet', '-m', 'pr'); git(other, 'push', '--quiet', 'origin', 'HEAD:main');
    };
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/journal.md', text: '- א' }, 'q:1'));
    await hq.memoryFiles.flush();
    land('memory/open-ron.md', '# מ-#116\n');
    assert.equal(await hq.memoryFiles.current('memory/open-ron.md'), '# מ-#116\n', 'PR open, main moved');
    assert.equal(await hq.memoryFiles.current('memory/journal.md'), '- א\n', 'the open PR is read too');

    // Squash-merged, branch deleted; then main edits the same file again.
    git(other, 'pull', '--quiet', 'origin', 'main');
    git(other, 'fetch', '--quiet', 'origin', BRANCH);
    git(other, 'merge', '--quiet', '--squash', 'FETCH_HEAD'); git(other, 'commit', '--quiet', '-m', 'squash');
    git(other, 'push', '--quiet', 'origin', 'HEAD:main', `:refs/heads/${BRANCH}`);
    prOpen = null;
    land('memory/journal.md', '- א מתוקן\n');
    assert.equal(await hq.memoryFiles.current('memory/journal.md'), '- א מתוקן\n', 'a stale branch copy is never read');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('current: merged without deleting the branch, and a conflict on one file, never hide what main has', async () => {
  const r = repo();
  const env = await makeEnv();
  try {
    const { hq } = env;
    let prOpen: string | null = null;
    hq.memoryFiles.run = async (cmd, args, cwd) => {
      if (cmd === 'gh') { if (args[1] === 'list') return prOpen ?? ''; prOpen = 'https://x/pull/11'; return prOpen; }
      return new Promise((res, rej) => execFile(cmd, args, { cwd, env: GIT_ENV }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
    };
    hq.memoryFiles.repoDir = r.checkout;
    const other = join(r.dir, 'other');
    git(r.dir, 'clone', '--quiet', join(r.dir, 'origin.git'), other);
    const land = (file: string, text: string) => {
      git(other, 'pull', '--quiet', '--no-rebase', 'origin', 'main');
      mkdirSync(join(other, 'memory'), { recursive: true });
      writeFileSync(join(other, file), text);
      git(other, 'add', '.'); git(other, 'commit', '--quiet', '-m', 'pr'); git(other, 'push', '--quiet', 'origin', 'HEAD:main');
    };
    land('memory/open-ron.md', 'בסיס\n');
    land('memory/b.md', 'ב בסיס\n');
    hq.ingest.op(entry({ scope: 'project', kind: 'fact', file: 'memory/open-ron.md', text: 'מה-PR', mode: 'replace' }, 'w:1'));
    await hq.memoryFiles.flush();

    // main changes the PR's file another way (conflict) and another file: the other file is main's, the PR's file the PR's.
    land('memory/open-ron.md', 'מ-main\n');
    land('memory/b.md', 'ב מ-main\n');
    assert.equal(await hq.memoryFiles.current('memory/b.md'), 'ב מ-main\n');
    assert.equal(await hq.memoryFiles.current('memory/open-ron.md'), 'מה-PR\n');

    // Merged (here: main takes the PR's text) and the branch left behind; the PR is closed, main moves on.
    land('memory/open-ron.md', 'מה-PR\n');
    prOpen = null;
    land('memory/open-ron.md', 'אחרי המיזוג\n');
    assert.ok(git(r.checkout, 'ls-remote', 'origin', `refs/heads/${BRANCH}`), 'the branch is still there');
    assert.equal(await hq.memoryFiles.current('memory/open-ron.md'), 'אחרי המיזוג\n');
  } finally { await env.cleanup(); r.cleanup(); }
});
