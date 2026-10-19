// Mutation tests for check-contract.mjs: each broken copy of the contract must fail with the expected message.
// Run: npm run test:contract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
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
  ['colour in skill frontmatter', 'colour fields', (d) => edit(d, 'company/skills/verify/SKILL.md', 'name: verify\n', 'name: verify\ncolor: x\n')],
  ['malformed percent escape', 'not valid URL encoding', (d) => appendFileSync(join(d, 'memory/company/machines.md'), '\n[x](a%zz.md)\n')],
  ['emoji in a name', 'contains an emoji', (d) => edit(d, 'company/org.yaml', 'name: יואב', 'name: "🧭 יואב"')],
  ['unknown home machine', 'home "', (d) => edit(d, 'company/org.yaml', 'home: hq-host', 'home: mars')],
  ['grant without quote', 'grant is missing', (d) => edit(d, 'company/projects/lumo.md', 'grants: []', 'grants:\n  - team: monitoring\n    action: rollback')],
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
