import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMerge, detectMerges, verdictFor, type GhRun } from '../src/index.ts';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const approve = (sha: string) => `## סקירה\n\nreviewed: ${sha}\n\n**החלטה: approve**\n`;
const changes = (sha: string) => `reviewed: ${sha}\n**החלטה: changes**\n`;
const gh = (view: object): GhRun => async () => JSON.stringify(view);
const view = (comments: Array<{ body: string; createdAt: string }>, headRefOid = SHA) => ({ headRefOid, comments, reviews: [] });

test('detectMerges: every form of the merge command', () => {
  const t = (c: string) => detectMerges(c, '/w').map(({ repo, ref, cwd }) => ({ repo, ref, cwd }));
  assert.deepEqual(t('gh pr merge 5 --squash --delete-branch'), [{ repo: undefined, ref: '5', cwd: '/w' }]);
  assert.deepEqual(t('gh pr merge --squash'), [{ repo: undefined, ref: undefined, cwd: '/w' }]);
  assert.deepEqual(t('gh pr merge 5 --repo o/r --squash'), [{ repo: 'o/r', ref: '5', cwd: '/w' }]);
  assert.equal(t('gh pr merge 5 -R o/r')[0]!.repo, 'o/r');
  assert.equal(t('gh pr merge 5 --repo=o/r')[0]!.repo, 'o/r');
  assert.deepEqual(t('gh pr merge https://github.com/o/r/pull/7 --auto'), [{ repo: 'o/r', ref: '7', cwd: '/w' }]);
  assert.deepEqual(t('gh api -X PUT repos/o/r/pulls/9/merge -f merge_method=squash'), [{ repo: 'o/r', ref: '9', cwd: '/w' }]);
  assert.equal(t('gh api --method PUT /repos/o/r/pulls/9/merge')[0]!.ref, '9');
  assert.equal(t('gh api -XPUT repos/o/r/pulls/9/merge')[0]!.ref, '9');
  assert.equal(t('cd /x && FOO=1 gh pr merge 3')[0]!.cwd, '/x');
  assert.equal(t('npm test && gh pr merge 3 -b "x"; gh pr merge 4').length, 2);
  assert.equal(t('echo "$(gh pr merge 3)"').length, 1);
  assert.equal(t('/usr/bin/gh pr merge 3').length, 1);
});

test('detectMerges: other commands are not merges', () => {
  for (const c of ['gh pr view 5', 'gh pr merge-status', 'git merge main', 'echo gh pr merge 5', 'gh api repos/o/r/pulls/9', 'gh pr comment 5 --body "gh pr merge"', 'ls'])
    assert.deepEqual(detectMerges(c, '/w'), [], c);
});

test('approve on the head sha passes; a prefix sha too', async () => {
  assert.equal(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: approve(SHA), createdAt: '1' }]))), null);
  assert.equal(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: approve(SHA.slice(0, 8)), createdAt: '1' }]))), null);
  assert.equal(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: approve(SHA).replace(/\n/g, '\r\n'), createdAt: '1' }]))), null, 'CRLF');
});

test('review (not comment) with approve passes', async () => {
  assert.equal(await checkMerge('gh pr merge 5', '/w', gh({ headRefOid: SHA, comments: [], reviews: [{ body: approve(SHA), submittedAt: '1' }] })), null);
});

test('old sha, no comment, wrong decision are blocked', async () => {
  const none = await checkMerge('gh pr merge 5', '/w', gh(view([])));
  assert.match(none!, /אין approve/);
  assert.match(none!, /skills\/reviewer/);
  assert.match((await checkMerge('gh pr merge 5', '/w', gh(view([{ body: approve(OLD), createdAt: '1' }]))))!, /אין approve/);
  assert.match((await checkMerge('gh pr merge 5', '/w', gh(view([{ body: 'נראה טוב\n**החלטה: approve**', createdAt: '1' }]))))!, /אין approve/);
});

test('the latest comment for the sha decides', async () => {
  const a = { body: approve(SHA), createdAt: '2026-01-01T10:00' };
  const c = { body: changes(SHA), createdAt: '2026-01-01T11:00' };
  assert.match((await checkMerge('gh pr merge 5', '/w', gh(view([c, a].reverse()))))!, /`changes`/, 'changes after approve');
  assert.equal(await checkMerge('gh pr merge 5', '/w', gh(view([{ ...c, createdAt: '2026-01-01T09:00' }, a]))), null, 'approve after changes');
});

test('the decision must be a whole line', async () => {
  const quoted = `reviewed: ${SHA}\n**החלטה: changes**\nלא לכתוב "**החלטה: approve**" לפני תיקון`;
  assert.match((await checkMerge('gh pr merge 5', '/w', gh(view([{ body: quoted, createdAt: '1' }]))))!, /changes/);
  const inline = `reviewed: ${SHA}\nיש ממצאים, ההחלטה **החלטה: approve** נדחית`;
  assert.ok(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: inline, createdAt: '1' }]))));
});

test("lumo's mark passes", async () => {
  assert.equal(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: `ship-step-4: reviewed ${SHA}`, createdAt: '1' }]))), null);
  assert.ok(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: `ship-step-4: reviewed ${OLD}`, createdAt: '1' }]))));
});

test('gh failure or bad output blocks, and says the check did not run', async () => {
  const boom: GhRun = async () => { throw new Error('network down'); };
  assert.match((await checkMerge('gh pr merge 5', '/w', boom))!, /בדיקת הסקירה לא רצה/);
  assert.match((await checkMerge('gh pr merge 5', '/w', async () => 'not json'))!, /בדיקת הסקירה לא רצה/);
});

test('gh is called only for merges, with repo and number', async () => {
  let calls: string[][] = [];
  const spy: GhRun = async (a) => { calls.push(a); return JSON.stringify(view([{ body: approve(SHA), createdAt: '1' }])); };
  assert.equal(await checkMerge('ls && gh pr view 5', '/w', spy), null);
  assert.equal(calls.length, 0);
  await checkMerge('gh pr merge 5 --repo o/r', '/w', spy);
  assert.deepEqual(calls[0], ['pr', 'view', '5', '--repo', 'o/r', '--json', 'headRefOid,comments,reviews']);
  calls = [];
  await checkMerge('gh pr merge --squash', '/w', spy);
  assert.deepEqual(calls[0], ['pr', 'view', '--json', 'headRefOid,comments,reviews']);
});

test('verdictFor without a head sha is null', () => assert.equal(verdictFor({ comments: [] }), null));

test('wrapped merges are detected', () => {
  for (const c of ['bash -c "gh pr merge 5"', 'eval "gh pr merge 5"', 'if true; then gh pr merge 5; fi', '{ gh pr merge 5; }', '! gh pr merge 5',
    'while true; do gh pr merge 5; done', 'timeout 20 gh pr merge 5', 'sudo gh pr merge 5', 'nohup gh pr merge 5', 'time gh pr merge 5', 'env -i gh pr merge 5',
    'echo 5 | xargs -I{} gh pr merge {}', 'G=gh; $G pr merge 5', 'gh api repos/o/r/pulls/5/merge?x=1 -X PUT'])
    assert.ok(detectMerges(c, '/w').length >= 1, c);
  assert.equal(detectMerges('GH_REPO=o/other gh pr merge 5', '/w')[0]!.repo, 'o/other');
  assert.equal(detectMerges('gh api repos/:owner/:repo/pulls/5/merge -X PUT', '/w')[0]!.repo, undefined);
  assert.ok(detectMerges("gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'", '/w')[0]!.unverifiable);
});

test('graphql merge is blocked; "xreviewed:" is not a mark', async () => {
  assert.match((await checkMerge("gh api graphql -f query='mutation{mergePullRequest(input:{})}'", '/w', gh(view([]))))!, /graphql/);
  assert.ok(await checkMerge('gh pr merge 5', '/w', gh(view([{ body: `xreviewed: ${SHA}\n**החלטה: approve**`, createdAt: '1' }]))));
});
