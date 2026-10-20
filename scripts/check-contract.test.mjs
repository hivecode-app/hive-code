// Mutation tests for check-contract.mjs: each broken copy of the contract must fail with the expected message.
// Run: npm run test:contract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'check-contract.mjs');

function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'));
  for (const d of ['company', 'memory', 'docs']) cpSync(join(repo, d), join(dir, d), { recursive: true });
  return dir;
}
function run(dir) {
  // HOME without ~/.claude/CLAUDE.md, so only the pinned hash guards the Authority block (as in CI).
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: { ...process.env, HOME: join(dir, 'nohome') } });
  return { code: r.status, out: r.stdout + r.stderr };
}
function edit(dir, file, from, to) {
  const p = join(dir, file);
  const s = readFileSync(p, 'utf8');
  assert.ok(s.includes(from), `fixture text not found in ${file}: ${from}`);
  writeFileSync(p, s.replace(from, to));
}

test('the real contract passes', () => {
  const dir = copy();
  const r = run(dir);
  rmSync(dir, { recursive: true });
  assert.equal(r.code, 0, r.out);
});

const cases = [
  ['emoji symbol', 'is an emoji', (d) => edit(d, 'company/org.yaml', 'symbol: shield', 'symbol: "🛡️"')],
  ['colour word as symbol', 'is a colour', (d) => edit(d, 'company/org.yaml', 'symbol: tune', 'symbol: red')],
  ['colour key', 'colour fields', (d) => edit(d, 'company/org.yaml', '    symbol: tune\n', '    symbol: tune\n    bg_color: x\n')],
  ['hex colour value', 'colour value', (d) => edit(d, 'company/org.yaml', 'helpers: ephemeral   #', 'helpers: "#ff0000"   #')],
  ['Authority weakened', 'pinned verbatim', (d) => edit(d, 'company/directives.md', 'except the five classes below', 'except the classes below')],
  ['Authority heading removed', 'heading is missing', (d) => edit(d, 'company/directives.md', '# Authority — read this before you decide you are not allowed\n', '# Authority\n')],
  ['missing identity file', 'has no file', (d) => rmSync(join(d, 'company/identities/uri.md'))],
  ['duplicate identity id', 'duplicate identity id', (d) => edit(d, 'company/org.yaml', '  - id: lia\n', '  - id: amit\n')],
  ['duplicate automation id', 'duplicate automation id', (d) => edit(d, 'company/org.yaml', '- id: said-twice', '- id: memory-consolidation')],
  ['plain list item', 'must be a mapping', (d) => edit(d, 'company/org.yaml', 'identities:\n', 'identities:\n  - stray\n')],
  ['reporting cycle', 'loops', (d) => edit(d, 'company/org.yaml', 'reports_to: ran', 'reports_to: rotem')],
  ['team membership drift', 'neither as lead nor as member', (d) => edit(d, 'company/org.yaml', 'members: [amit, lia, uri]', 'members: [lia, uri]')],
  ['orphan charter', 'not listed under projects', (d) => cpSync(join(d, 'company/projects/lumo.md'), join(d, 'company/projects/orphan.md'))],
  ['broken link with anchor', 'points to nothing', (d) => edit(d, 'memory/company/INDEX.md', '(machines.md)', '(gone.md#top)')],
  ['broken link in a body', 'points to nothing', (d) => appendFileSync(join(d, 'memory/company/machines.md'), '\n[x](../nowhere.md)\n')],
  ['empty org.yaml', 'non-empty mapping', (d) => writeFileSync(join(d, 'company/org.yaml'), '# nothing\n')],
  ['member of two teams', 'that identity says team', (d) => edit(d, 'company/org.yaml', 'members: [amit, lia, uri]', 'members: [amit, lia, uri, yoav]')],
  ['rgb colour value', 'colour value', (d) => edit(d, 'company/org.yaml', 'helpers: ephemeral   #', 'helpers: "rgb(255,0,0)"   #')],
  ['design reviewer unknown', 'design_review needs "reviewer"', (d) => edit(d, 'company/projects/agent-company.md', 'merge: worker-squash', 'design_review:\n  reviewer: nobody\n  paths: [packages/app/lib/]\nmerge: worker-squash')],
  ['colour in skill frontmatter', 'colour fields', (d) => edit(d, 'company/skills/verify/SKILL.md', 'name: verify\n', 'name: verify\ncolor: x\n')],
  ['malformed percent escape', 'not valid URL encoding', (d) => appendFileSync(join(d, 'memory/company/machines.md'), '\n[x](a%zz.md)\n')],
  ['emoji in a name', 'contains an emoji', (d) => edit(d, 'company/org.yaml', 'name: יואב', 'name: "🧭 יואב"')],
  ['unknown home machine', 'home "', (d) => edit(d, 'company/org.yaml', 'home: hq-host', 'home: mars')],
  ['machine dropped from the list', 'home "hq-host" is not one of', (d) => edit(d, 'company/org.yaml', 'machines: [hq-host, ci-host, laptop]', 'machines: [ci-host, laptop]')],
  ['manager is not an identity', '"manager" "nobody"', (d) => edit(d, 'company/org.yaml', 'manager: yoav ', 'manager: nobody ')],
  ['owner gender is not male|female', '"owner_gender" "f"', (d) => edit(d, 'company/org.yaml', 'owner_gender: male ', 'owner_gender: f ')],
  ['monitoring lead is not an identity', '"monitoring_lead" "nobody"', (d) => edit(d, 'company/org.yaml', 'monitoring_lead: rotem ', 'monitoring_lead: nobody ')],
  ['unknown time zone', '"timezone" must be an IANA', (d) => edit(d, 'company/org.yaml', 'timezone: Asia/Bangkok', 'timezone: Bangkok')],
  ['no time zone', '"timezone" must be an IANA', (d) => edit(d, 'company/org.yaml', 'timezone: Asia/Bangkok', '# no zone')],
  ['grant without quote', 'grant is missing', (d) => edit(d, 'company/projects/lumo.md', 'grants: []', 'grants:\n  - team: monitoring\n    action: rollback')],
  ['checkout without path', 'every checkout needs', (d) => edit(d, 'company/projects/lumo.md', '    path: ~/new-lumo-application\n', '')],
  ['relative checkout path', 'must be absolute', (d) => edit(d, 'company/projects/lumo.md', 'path: ~/new-lumo-application', 'path: new-lumo-application')],
  ['worktree_dir outside the checkout', 'inside the checkout', (d) => edit(d, 'company/projects/lumo.md', 'worktree_dir: .worktrees', 'worktree_dir: ../wt')],
  ['required CI without a check name', 'needs "ci_check"', (d) => edit(d, 'company/projects/agent-company.md', 'ci_check: company-ci', 'ci_check: null')],
  ['unquoted ": " in a charter value (#70)', 'company/projects/lumo.md:', (d) => edit(d, 'company/projects/lumo.md', 'worktree_dir: .worktrees', 'worktree_dir: a: b')],
  ['charter YAML the subset accepts but yaml rejects', 'invalid YAML', (d) => edit(d, 'company/projects/lumo.md', 'worktree_dir: .worktrees', 'worktree_dir: "a" b')],
  ['broken YAML in org.yaml', 'company/org.yaml:', (d) => edit(d, 'company/org.yaml', 'home: hq-host', 'home: hq-host: x')],
  ['merge_instructions that is not text', 'must be a string or a list', (d) => edit(d, 'company/projects/agent-company.md', 'ci_check: company-ci', 'ci_check: company-ci\nmerge_instructions: [1, 2]')],
];

for (const [name, expect, mutate] of cases) {
  test(`fails on: ${name}`, () => {
    const dir = copy();
    try {
      mutate(dir);
      const r = run(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
}

test('broken charter YAML is reported at its line in the file (#70)', () => {
  const dir = copy();
  try {
    const file = 'company/projects/lumo.md';
    edit(dir, file, 'worktree_dir: .worktrees', 'worktree_dir: a: b');
    const line = readFileSync(join(dir, file), 'utf8').split('\n').findIndex((l) => l.startsWith('worktree_dir: a: b')) + 1;
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`${file}:${line}: invalid YAML`));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The starter kit (starter/): the skeleton a new company starts from, and the examples the setup copies.
// ---------------------------------------------------------------------------
function copyStarter() {
  const dir = mkdtempSync(join(tmpdir(), 'starter-'));
  for (const d of ['company', 'memory', 'examples']) cpSync(join(repo, 'starter', d), join(dir, d), { recursive: true });
  return dir;
}

// What the setup conversation writes (skills/setup "מה נוצר"), from examples/: the skeleton becomes a company.
async function finishSetup(dir) {
  const { parse, stringify } = await import('yaml');
  const orgPath = join(dir, 'company/org.yaml');
  const org = parse(readFileSync(orgPath, 'utf8'));
  const add = parse(readFileSync(join(dir, 'examples/org-additions.yaml'), 'utf8'));
  delete org.setup;
  Object.assign(org, { owner_name: 'דנה', owner_gender: 'female', timezone: 'Asia/Jerusalem', machines: ['srv1'], monitoring_lead: add.monitoring_lead });
  Object.assign(org.identities[0], { name: 'יובל', monogram: 'יו', home: 'srv1' });
  org.projects = [...org.projects, ...add.projects];
  org.teams = [...org.teams, ...add.teams];
  org.identities = [...org.identities, ...add.identities];
  writeFileSync(orgPath, stringify(org, { lineWidth: 0 }));
  for (const f of ['projects/example-app.md', 'projects/old-site.md', 'identities/aviv.md', 'identities/hadar.md']) {
    cpSync(join(dir, 'examples', f), join(dir, 'company', f));
  }
  mkdirSync(join(dir, 'memory/projects/example-app'));
  writeFileSync(join(dir, 'memory/projects/example-app/INDEX.md'), '# האפליקציה (L3)\n');
  appendFileSync(join(dir, 'memory/projects/INDEX.md'), '| [example-app](example-app/INDEX.md) | האפליקציה |\n');
}

test('the starter kit passes as a skeleton', () => {
  const dir = copyStarter();
  try {
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the starter kit with the examples set up passes', async () => {
  const dir = copyStarter();
  try {
    await finishSetup(dir);
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /^warn /m, r.out);
  } finally { rmSync(dir, { recursive: true }); }
});

const starterCases = [
  ['setup done without a time zone', '"timezone" must be an IANA', (d) => edit(d, 'company/org.yaml', 'setup: pending\n', '')],
  ['setup done without the owner name', '"owner_name" must be a non-empty name', (d) => edit(d, 'company/org.yaml', 'setup: pending\n', '')],
  ['manager without a name', 'identity "manager" has no name', (d) => edit(d, 'company/org.yaml', 'name: מנהל החברה', 'name:')],
  ['setup flag with another value', '"setup" can only be "pending"', (d) => edit(d, 'company/org.yaml', 'setup: pending\nowner:', 'setup: done\nowner:')],
  ['generic Authority edited', 'differs from the engine', (d) => edit(d, 'company/directives.md', 'מותר לך הכול, חוץ מחמשת הסוגים', 'מותר לך הכול, חוץ מהסוגים')],
  ['generic Authority without its end marker', 'must run from', (d) => edit(d, 'company/directives.md', '<!-- /AUTHORITY -->', '')],
];

for (const [name, expect, mutate] of starterCases) {
  test(`starter fails on: ${name}`, () => {
    const dir = copyStarter();
    try {
      mutate(dir);
      const r = run(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally { rmSync(dir, { recursive: true }); }
  });
}

test('the starter kit carries nothing of the owner of this repo', () => {
  const r = spawnSync('grep', ['-rniE', 'רן|יואב|ran|hivecode', join(repo, 'starter')], { encoding: 'utf8' });
  assert.equal(r.stdout, '', r.stdout);
});
