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
// The example company the engine's tests run on (fixtures/README.md). The real one is checked by --home.
const fixture = join(repo, 'fixtures', 'company-home');
const script = join(repo, 'scripts', 'check-contract.mjs');

function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'));
  for (const d of ['company', 'memory']) cpSync(join(fixture, d), join(dir, d), { recursive: true });
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

test('the example company passes', () => {
  const dir = copy();
  const r = run(dir);
  rmSync(dir, { recursive: true });
  assert.equal(r.code, 0, r.out);
});

test('a team tone from the eight passes, though "blue" is a colour word', () => {
  const dir = copy();
  try {
    edit(dir, 'company/org.yaml', '    symbol: tune\n', '    symbol: tune\n    tone: blue\n');
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

const cases = [
  ['emoji symbol', 'is an emoji', (d) => edit(d, 'company/org.yaml', 'symbol: shield', 'symbol: "🛡️"')],
  ['colour word as symbol', 'is a colour', (d) => edit(d, 'company/org.yaml', 'symbol: tune', 'symbol: red')],
  ['colour key', 'colour fields', (d) => edit(d, 'company/org.yaml', '    symbol: tune\n', '    symbol: tune\n    bg_color: x\n')],
  ['hex colour value', 'colour value', (d) => edit(d, 'company/org.yaml', 'helpers: ephemeral   #', 'helpers: "#ff0000"   #')],
  ['Authority weakened', 'differs from the engine', (d) => edit(d, 'company/directives.md', 'מותר לך הכול, חוץ מחמשת הסוגים', 'מותר לך הכול, חוץ מהסוגים')],
  ['the owner\'s own Authority, not verbatim', 'pinned verbatim', (d) => edit(d, 'company/directives.md', '# סמכות: קרא את זה לפני שאתה מחליט שאסור לך\n', '# Authority — read this before you decide you are not allowed\n\nnot the text\n\n<!-- /RAN:AUTHORITY -->\n\n# סמכות: קרא את זה לפני שאתה מחליט שאסור לך\n')],
  ['Authority heading removed', 'heading is missing', (d) => edit(d, 'company/directives.md', '# סמכות: קרא את זה לפני שאתה מחליט שאסור לך\n', '# סמכות\n')],
  ['missing identity file', 'has no file', (d) => rmSync(join(d, 'company/identities/ofir.md'))],
  ['duplicate identity id', 'duplicate identity id', (d) => edit(d, 'company/org.yaml', '  - id: noam\n', '  - id: maya\n')],
  ['duplicate automation id', 'duplicate automation id', (d) => edit(d, 'company/org.yaml', '- id: said-twice', '- id: memory-consolidation')],
  ['plain list item', 'must be a mapping', (d) => edit(d, 'company/org.yaml', 'identities:\n', 'identities:\n  - stray\n')],
  ['reporting cycle', 'loops', (d) => edit(d, 'company/org.yaml', 'reports_to: shira', 'reports_to: hadar')],
  ['team membership drift', 'neither as lead nor as member', (d) => edit(d, 'company/org.yaml', 'members: [maya, noam, lior]', 'members: [noam, lior]')],
  ['orphan charter', 'not listed under projects', (d) => cpSync(join(d, 'company/projects/shop.md'), join(d, 'company/projects/orphan.md'))],
  ['broken link with anchor', 'points to nothing', (d) => edit(d, 'memory/company/INDEX.md', '(machines.md)', '(gone.md#top)')],
  ['broken link in a body', 'points to nothing', (d) => appendFileSync(join(d, 'memory/company/machines.md'), '\n[x](../nowhere.md)\n')],
  ['empty org.yaml', 'non-empty mapping', (d) => writeFileSync(join(d, 'company/org.yaml'), '# nothing\n')],
  ['member of two teams', 'that identity says team', (d) => edit(d, 'company/org.yaml', 'members: [maya, noam, lior]', 'members: [maya, noam, lior, gal]')],
  ['rgb colour value', 'colour value', (d) => edit(d, 'company/org.yaml', 'helpers: ephemeral   #', 'helpers: "rgb(255,0,0)"   #')],
  ['design reviewer unknown', 'design_review needs "reviewer"', (d) => edit(d, 'company/projects/engine.md', 'merge: worker-squash', 'design_review:\n  reviewer: nobody\n  paths: [packages/app/lib/]\nmerge: worker-squash')],
  ['paused not a reason', '"paused" must be true or the reason', (d) => edit(d, 'company/projects/engine.md', 'merge: worker-squash', 'paused: 3\nmerge: worker-squash')],
  ['colour in skill frontmatter', 'colour fields', (d) => edit(d, 'company/skills/verify/SKILL.md', 'name: verify\n', 'name: verify\ncolor: x\n')],
  ['malformed percent escape', 'not valid URL encoding', (d) => appendFileSync(join(d, 'memory/company/machines.md'), '\n[x](a%zz.md)\n')],
  ['emoji in a name', 'contains an emoji', (d) => edit(d, 'company/org.yaml', 'name: גל', 'name: "🧭 גל"')],
  ['unknown home machine', 'home "', (d) => edit(d, 'company/org.yaml', 'home: srv1', 'home: mars')],
  ['machine dropped from the list', 'home "srv1" is not one of', (d) => edit(d, 'company/org.yaml', 'machines: [srv1, srv2, laptop]', 'machines: [srv2, laptop]')],
  ['manager is not an identity', '"manager" "nobody"', (d) => edit(d, 'company/org.yaml', 'manager: gal\n', 'manager: nobody\n')],
  ['owner gender is not male|female', '"owner_gender" "f"', (d) => edit(d, 'company/org.yaml', 'owner_gender: female\n', 'owner_gender: f\n')],
  ['monitoring lead is not an identity', '"monitoring_lead" "nobody"', (d) => edit(d, 'company/org.yaml', 'monitoring_lead: hadar\n', 'monitoring_lead: nobody\n')],
  ['unknown time zone', '"timezone" must be an IANA', (d) => edit(d, 'company/org.yaml', 'timezone: Asia/Bangkok', 'timezone: Bangkok')],
  ['no time zone', '"timezone" must be an IANA', (d) => edit(d, 'company/org.yaml', 'timezone: Asia/Bangkok', '# no zone')],
  ['grant without quote', 'grant is missing', (d) => edit(d, 'company/projects/shop.md', 'grants: []', 'grants:\n  - team: monitoring\n    action: rollback')],
  ['checkout without path', 'every checkout needs', (d) => edit(d, 'company/projects/shop.md', '    path: ~/shop-app\n', '')],
  ['relative checkout path', 'must be absolute', (d) => edit(d, 'company/projects/shop.md', 'path: ~/shop-app', 'path: shop-app')],
  ['worktree_dir outside the checkout', 'inside the checkout', (d) => edit(d, 'company/projects/shop.md', 'worktree_dir: .worktrees', 'worktree_dir: ../wt')],
  ['required CI without a check name', 'needs "ci_check"', (d) => edit(d, 'company/projects/engine.md', 'ci_check: engine-ci', 'ci_check: null')],
  ['unquoted ": " in a charter value (#70)', 'company/projects/shop.md:', (d) => edit(d, 'company/projects/shop.md', 'worktree_dir: .worktrees', 'worktree_dir: a: b')],
  ['charter YAML the subset accepts but yaml rejects', 'invalid YAML', (d) => edit(d, 'company/projects/shop.md', 'worktree_dir: .worktrees', 'worktree_dir: "a" b')],
  ['broken YAML in org.yaml', 'company/org.yaml:', (d) => edit(d, 'company/org.yaml', 'home: srv1', 'home: srv1: x')],
  ['team tone outside the eight', 'tone "purple" is not one of', (d) => edit(d, 'company/org.yaml', '    symbol: tune\n', '    symbol: tune\n    tone: purple\n')],
  ['tone on an identity, not its team', 'colour value', (d) => edit(d, 'company/org.yaml', '    symbol: shield\n', '    symbol: shield\n    tone: blue\n')],
  ['merge_instructions that is not text', 'must be a string or a list', (d) => edit(d, 'company/projects/engine.md', 'ci_check: engine-ci', 'ci_check: engine-ci\nmerge_instructions: [1, 2]')],
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

// Paths a charter points a worker at: the company's (~/company, /home/<user>/company) map onto the checked tree,
// the engine's (~/projects/agent-company) onto this engine, skills/ onto company/skills.
const GOOD_PATHS = "merge_instructions:\n  - 'סקירה לפי `/home/someone/company/company/skills/reviewer/SKILL.md`.'\n  - 'פריסה לפי `~/company/company/skills/ship/SKILL.md`, בדיקה ב-`node ~/projects/agent-company/scripts/check-contract.mjs .`.'\n";
test('charter paths that exist pass: company, engine, skills/, and paths that are not ours', () => {
  const dir = copy();
  try {
    edit(dir, 'company/projects/engine.md', 'grants: []\n', `grants: []\n${GOOD_PATHS}`);
    appendFileSync(join(dir, 'company/projects/engine.md'), '\nלפני: `skills/verify/SKILL.md` ו-`../skills/setup/SKILL.md`, [הסוקר](../skills/reviewer/SKILL.md#שלבים), `~/company/company/skills/ship/SKILL.md:12`, וגם בלי קוד ~/company/company/skills/verify/SKILL.md, ב-/home/someone/company/company/skills/ship/SKILL.md:3-9 ו-**~/company/company/skills/setup/SKILL.md**!, [~/company/company/skills/ship/SKILL.md](../skills/ship/SKILL.md), https://example.com/home/x/company/nope בשרת אחר: `/root/app.env`, `~/projects/engine-<slug>`.\n');
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

for (const [name, text, missing] of [
  ['the engine path of #156', "merge_instructions:\n  - 'סקירה לפי `/home/someone/projects/agent-company/company/skills/reviewer/SKILL.md`.'\n", '/home/someone/projects/agent-company/company/skills/reviewer/SKILL.md'],
  ['a plain company path, without code', "merge_instructions: 'לפי /home/someone/company/company/skills/nope/SKILL.md'\n", '/home/someone/company/company/skills/nope/SKILL.md'],
  ['a plain path after a Hebrew prefix', "merge_instructions: 'פריסה ב-~/projects/agent-company/company/skills/ship/SKILL.md'\n", '~/projects/agent-company/company/skills/ship/SKILL.md'],
  ['an absolute link target, after its anchor', "merge_instructions: '[הסוקר](/home/someone/company/company/skills/nope/SKILL.md#שלבים)'\n", '/home/someone/company/company/skills/nope/SKILL.md'],
  ['a company skill that is not there', "merge_instructions: 'לפי `~/company/company/skills/nope/SKILL.md`'\n", '~/company/company/skills/nope/SKILL.md'],
]) {
  test(`fails on a charter path that does not exist: ${name}, with charter and line`, () => {
    const dir = copy();
    try {
      const file = 'company/projects/engine.md';
      edit(dir, file, 'grants: []\n', `grants: []\n${text}`);
      const line = readFileSync(join(dir, file), 'utf8').split('\n').findIndex((l) => l.includes(missing)) + 1;
      const r = run(dir);
      assert.equal(r.code, 1, r.out);
      assert.ok(r.out.includes(`${file}:${line}: path "${missing}" does not exist`), r.out);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
}

test('fails on a relative skills/ path in a charter body', () => {
  const dir = copy();
  try {
    appendFileSync(join(dir, 'company/projects/shop.md'), '\nלפני שכותבים: `skills/flutter/SKILL.md`.\n');
    const r = run(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /company\/projects\/shop\.md:\d+: path "skills\/flutter\/SKILL\.md" does not exist/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('broken charter YAML is reported at its line in the file (#70)', () => {
  const dir = copy();
  try {
    const file = 'company/projects/shop.md';
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

test('the starter kit and the fixtures carry nothing of the owner of this repo', () => {
  const r = spawnSync('grep', ['-rniE', 'רן|יואב|ran|hivecode', join(repo, 'starter'), join(repo, 'fixtures')], { encoding: 'utf8' });
  assert.equal(r.stdout, '', r.stdout);
});

// A PR in the company's own repo is checked from its worktree: `npm run check:contract -- --home <path>`, which
// reaches the script as `--home --home <path>`. The path wins over COMPANY_HOME and hq.config.json.
test('--home <path> checks that path, also as npm passes it', () => {
  const dir = copyStarter();
  try {
    edit(dir, 'company/org.yaml', 'name: מנהל החברה', 'name:');
    const env = { ...process.env, HOME: join(dir, 'nohome'), COMPANY_HOME: join(repo, 'starter') };
    for (const args of [['--home', dir], ['--home', '--home', dir]]) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, new RegExp(`check:contract --home: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(r.stdout + r.stderr, /identity "manager" has no name/);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
