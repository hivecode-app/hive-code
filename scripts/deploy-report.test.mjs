import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployedPrs, partOf, prOf, tasksOf } from './deploy-report.mjs';

test('partOf: app, caddy, nothing for docs, hq for the rest', () => {
  assert.equal(partOf('packages/app/lib/main.dart'), 'app');
  assert.equal(partOf('deploy/caddy/agent-company.caddy'), 'caddy');
  assert.equal(partOf('docs/SPEC.md'), null);
  assert.equal(partOf('README.md'), null);
  assert.equal(partOf('packages/hq/src/api.ts'), 'hq');
  assert.equal(partOf('company/org.yaml'), 'hq');
  assert.equal(partOf('deploy/agent-company-hq.service'), 'hq');
});

test('prOf: only a squash merge subject', () => {
  assert.equal(prOf('hq: מה לבדוק (#108)'), '108');
  assert.equal(prOf('hq: הודעת סגירה (#99) (#101)'), '101');
  assert.equal(prOf('wip'), null);
});

test('deployedPrs: a PR is live only when every part it touches is', () => {
  const commits = [
    { sha: 'c3', subject: 'app and hq (#3)', files: ['packages/app/a.dart', 'packages/hq/src/x.ts'] },
    { sha: 'c2', subject: 'app only (#2)', files: ['packages/app/a.dart'] },
    { sha: 'c1', subject: 'hq only (#1)', files: ['packages/hq/src/x.ts'] },
    { sha: 'c0', subject: 'docs (#0)', files: ['docs/SPEC.md'] },
    { sha: 'cx', subject: 'not a PR', files: ['packages/hq/src/x.ts'] },
  ];
  // hq deployed at c3, the app still at an old release (before c2).
  const live = (part) => part === 'hq';
  assert.deepEqual(deployedPrs(commits, live), ['1', '0']);
  assert.deepEqual(deployedPrs(commits, () => true), ['3', '2', '1', '0']);
});

test('tasksOf: company-t<id> branches of the deployed PRs', () => {
  const merged = [{ number: 108, headRefName: 'company-t64' }, { number: 99, headRefName: 'fix-x' }, { number: 7, headRefName: 'company-t3' }];
  assert.deepEqual(tasksOf(['108', '99'], merged), [64]);
});
