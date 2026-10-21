import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { latestTag, pinnedClaude, migrationBody } from './engine.mjs';
import { ORG_VERSION, orgVersion, orgPlan, migrateOrg } from './org-migrations.mjs';

const ENGINE = join(import.meta.dirname, 'engine.mjs');

test('latest-tag: the highest vX.Y.Z by number, pre-releases and other tags skipped', () => {
  const ls = ['v1.2.9', 'v1.2.10', 'v1.10.0-rc1', 'v0.9.0', 'nightly', 'v2'].map((t) => `abc\trefs/tags/${t}`).join('\n');
  assert.equal(latestTag(ls), 'v1.2.10');
  assert.equal(latestTag(''), null);
});

test('pinned-claude: read from the engine itself', () => {
  assert.match(pinnedClaude(), /^\d+\.\d+\.\d+$/);
  assert.equal(execFileSync('node', [ENGINE, 'pinned-claude'], { encoding: 'utf8' }).trim(), pinnedClaude());
});

const ORG = '# comment stays\nversion: 1   # the format\nowner: owner\nteams: []\n';
const toTwo = { to: 2, title: 'teams נקרא squads', apply: (t) => t.replace(/^teams:/m, 'squads:') };

test('org.yaml: same version is ok, older needs a migration, newer is refused, a gap is named', () => {
  assert.equal(orgVersion(ORG), 1);
  assert.equal(orgVersion('owner: x\n'), 1);
  assert.throws(() => orgVersion('version: two\n'));
  assert.equal(orgPlan(ORG, 1, []).action, 'ok');
  assert.deepEqual(orgPlan(ORG.replace('version: 1', 'version: 3'), 2, [toTwo]).action, 'newer');
  assert.equal(orgPlan(ORG, 2, [toTwo]).action, 'migrate');
  assert.deepEqual({ ...orgPlan(ORG, 3, [toTwo]), steps: undefined }, { action: 'missing', from: 1, to: 3, missing: 3, steps: undefined });
});

test('org.yaml migration: works on the text, keeps comments, sets version', () => {
  const plan = orgPlan(ORG, 2, [toTwo]);
  const out = migrateOrg(ORG, plan);
  assert.equal(out, '# comment stays\nversion: 2 # the format\nowner: owner\nsquads: []\n');
  assert.equal(orgVersion(out), 2);
  assert.match(migrationBody(plan), /teams נקרא squads/);
  assert.throws(() => migrateOrg(ORG, orgPlan(ORG, 1, [])));
});

test('this engine reads the org.yaml of the starter kit and of the company', () => {
  for (const f of ['starter/company/org.yaml', 'company/org.yaml']) {
    const p = join(import.meta.dirname, '..', f);
    if (existsSync(p)) assert.equal(orgPlan(readFileSync(p, 'utf8')).action, 'ok', f);
  }
  assert.equal(execFileSync('node', [ENGINE, 'org-plan', join(import.meta.dirname, '../starter')], { encoding: 'utf8' }).trim(), `ok ${ORG_VERSION} ${ORG_VERSION}`);
});

test('hq.db: an online backup (600), and the migrations run on a copy only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-db-'));
  try {
    const live = join(dir, 'hq.db');
    new Database(live).close();
    execFileSync('node', [ENGINE, 'db-backup', live, join(dir, 'b.db')]);
    assert.equal(statSync(join(dir, 'b.db')).mode & 0o777, 0o600);
    const [before, after] = execFileSync('node', [ENGINE, 'db-migrate-dry', join(dir, 'b.db')], { encoding: 'utf8' }).trim().split(' ').map(Number);
    assert.equal(before, 0);
    assert.ok(after > 0);
    const db = new Database(live, { readonly: true });
    assert.equal(db.pragma('user_version', { simple: true }), 0, 'the live db is not migrated by the dry run');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shifts-rested: a unit hq ended on purpose after the mark; a crash, a dead one, a live one and older events are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-rested-'));
  try {
    const file = join(dir, 'hq.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, identity TEXT, data TEXT NOT NULL DEFAULT 'null')`);
    const ev = (data) => db.prepare(`INSERT INTO events (ts, type, identity, data) VALUES (0, 'shift.state', 'x', ?)`).run(JSON.stringify(data));
    ev({ shift: 'old-1', state: 'ended', reason: 'rest' });
    const mark = execFileSync('node', [ENGINE, 'events-seq', file], { encoding: 'utf8' }).trim();
    assert.equal(mark, '1');
    ev({ shift: 'dana-3', state: 'ended', reason: 'rest' });
    ev({ shift: 'noa-2', state: 'ended', reason: 'crash' });
    ev({ shift: 'mia-1', state: 'ended', reason: 'no_result' });
    ev({ shift: 'ben-1', state: 'ended', reason: 'crashed' });
    ev({ shift: 'tom-1', state: 'dead', reason: 'host_gone' });
    ev({ shift: 'rut-1', state: 'ended', reason: 'task_done' });
    ev({ shift: 'rut-1', state: 'starting' }); // started again: the last record is not an end
    ev({ shift: 'eli-1', state: 'live' });
    db.close();
    const out = execFileSync('node', [ENGINE, 'shifts-rested', file, mark], { encoding: 'utf8' }).trim();
    assert.equal(out, 'company-shift@dana-3.service');
    // No db at all (a fresh install): the mark is 0 and nothing is rested.
    assert.equal(execFileSync('node', [ENGINE, 'events-seq', join(dir, 'none.db')], { encoding: 'utf8' }).trim(), '0');
    assert.equal(execFileSync('node', [ENGINE, 'shifts-rested', join(dir, 'none.db'), '0'], { encoding: 'utf8' }).trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
