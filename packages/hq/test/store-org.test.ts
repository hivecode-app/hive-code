import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { parseOrg, syncOrg } from '../src/org.ts';
import { sessionIdFor, uuidv5 } from '../src/proc.ts';
import { ORG_YAML } from './helpers.ts';
import { readFileSync, writeFileSync } from 'node:fs';

test('store: WAL, migrations idempotent across reopen, toggles seeded once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-store-'));
  try {
    const path = join(dir, 'hq.db');
    const s1 = new Store(path);
    assert.equal(s1.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(s1.schemaVersion, 1);
    s1.setToggle('probes', false);
    s1.close();
    const s2 = new Store(path);
    assert.equal(s2.schemaVersion, 1);
    assert.equal(s2.toggle('probes'), false, 'manual off survives restart');
    assert.equal(s2.toggle('scheduler'), true);
    const e = s2.emit('x', 'eli', { a: 1 });
    assert.deepEqual(s2.eventsAfter(e.seq - 1).at(-1)!.data, { a: 1 });
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('org.yaml (contract shape) → identities and automation switches', () => {
  const { identities, automations } = parseOrg(ORG_YAML, [], 'yoav');
  const by = Object.fromEntries(identities.map((r) => [r.id, r]));
  assert.equal(by.yoav!.lifecycle, 'resident', 'resident: true');
  assert.equal(by.yoav!.reports_to, null, 'reports to the owner = top of the chain');
  assert.equal(by.rotem!.reports_to, 'yoav');
  assert.equal(by.rotem!.lifecycle, 'lead');
  assert.equal(by.amit!.reports_to, 'eli');
  assert.equal(by.amit!.lifecycle, 'dormant');
  assert.equal(by.amit!.symbol, 'payments');
  assert.equal(by.eli!.team, 'personal');
  assert.equal(by['ac-ceo']!.project, 'agent-company');
  assert.equal(by['ac-ceo']!.team_kind, 'project');
  assert.deepEqual(JSON.parse(by.amit!.data), { memory_domain: 'personal/finance' });
  assert.deepEqual(automations.map((a) => [a.key, a.enabled]), [['rotem/prod-probes', true], ['rotem/ci-host-heartbeat', false]]);
});

test('org.yaml (B.1 sketch shape, people inline) still parses', () => {
  const { identities } = parseOrg(`
teams:
  - id: personal
    kind: permanent
    lead: {id: eli, name: אלי, title: ראש הצוות האישי}
    members:
      - {id: amit, name: עמית, title: מומחה כספים, lifecycle: dormant}
  - id: management
    lead: {id: yoav, name: יואב}
`, ['yoav'], 'yoav');
  const by = Object.fromEntries(identities.map((r) => [r.id, r]));
  assert.equal(by.eli!.reports_to, 'yoav');
  assert.equal(by.amit!.reports_to, 'eli');
  assert.equal(by.yoav!.lifecycle, 'resident');
  assert.equal(by.yoav!.reports_to, null);
});

test('syncOrg: missing file is not fatal; removed identities are deactivated; manual switch wins over the contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-org-'));
  try {
    const store = new Store(':memory:');
    assert.equal(syncOrg(store, dir, [], 'yoav'), 0);
    writeFileSync(join(dir, 'org.yaml'), ORG_YAML);
    assert.equal(syncOrg(store, dir, [], 'yoav'), 5);
    assert.equal(store.toggle('rotem/prod-probes'), true);
    store.setToggle('rotem/prod-probes', false, true);
    syncOrg(store, dir, [], 'yoav');
    assert.equal(store.toggle('rotem/prod-probes'), false, '"כובה ידנית" stays off');
    writeFileSync(join(dir, 'org.yaml'), ORG_YAML.replace(/^ {2}- \{id: amit.*\n/m, ''));
    syncOrg(store, dir, [], 'yoav');
    assert.equal((store.db.prepare(`SELECT active FROM identities WHERE id = 'amit'`).get() as { active: number }).active, 0, 'deactivated, not deleted');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real contract parses: company/org.yaml in this repo', () => {
  const file = join(import.meta.dirname, '..', '..', '..', 'company', 'org.yaml');
  const { identities, automations } = parseOrg(readFileSync(file, 'utf8'), [], 'yoav');
  const by = Object.fromEntries(identities.map((r) => [r.id, r]));
  assert.equal(by.yoav?.lifecycle, 'resident');
  assert.equal(by.rotem?.reports_to, 'yoav');
  assert.ok(automations.some((a) => a.key === 'rotem/prod-probes'));
});

test('deterministic session ids: uuidv5 (RFC 4122 vector) per identity:shift', () => {
  // RFC 4122 appendix / python uuid.uuid5(NAMESPACE_DNS, "python.org")
  assert.equal(uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  assert.equal(sessionIdFor('eli', 1), sessionIdFor('eli', 1));
  assert.notEqual(sessionIdFor('eli', 1), sessionIdFor('eli', 2));
  assert.match(sessionIdFor('dana', 7), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('host-args.json for the template unit: shift and shift-no come from the store', async () => {
  const { hostArgs, shiftUnit } = await import('../src/shifts.ts');
  const args = hostArgs({ shiftId: 'yoav-3', identity: 'yoav', shiftNo: 3, sessionId: sessionIdFor('yoav', 3), resume: true,
    kind: 'resident', cwd: '/w', socketPath: '/s', taskId: null, unit: shiftUnit('yoav-3') }, '/state');
  assert.deepEqual(args, { identity: 'yoav', shift: 'yoav-3', 'shift-no': '3', 'session-id': sessionIdFor('yoav', 3), cwd: '/w', 'state-dir': '/state', resume: true });
  assert.equal(shiftUnit('yoav-3'), 'company-shift@yoav-3.service');
});

test('system prompt (L0+L1): dossier, how to reply, Authority, charter; task workers get the task-team rules', async () => {
  const { buildSystemPrompt } = await import('../src/system-prompt.ts');
  const { join } = await import('node:path');
  const companyDir = join(import.meta.dirname, '..', '..', '..', 'company');
  const base = { symbol: '', team: null, team_kind: 'permanent', project: null, reports_to: null, lifecycle: 'resident', source: 'org', active: 1, data: '{}', updated_at: 0 };
  const yoav = buildSystemPrompt(companyDir, { ...base, id: 'yoav', name: 'יואב', title: 'מנהל החברה' }, 'yoav');
  assert.match(yoav, /אתה יואב, מנהל החברה/);
  assert.match(yoav, /# יואב · מנהל החברה/);                    // the dossier itself
  assert.match(yoav, /The complete list of things you may not do/); // Authority, verbatim (directives.md)
  assert.match(yoav, /`tell`/);
  assert.match(yoav, /ה-identity של רן הוא `owner`/);
  const worker = buildSystemPrompt(companyDir, { ...base, id: 'agent-company-t7', name: 't7', title: 'fix typo', team_kind: 'task',
    project: 'agent-company', reports_to: 'adi', lifecycle: 'ephemeral', source: 'runtime' }, 'yoav');
  assert.match(worker, /צוות משימה/);
  assert.match(worker, /gh pr merge --squash/);
  assert.match(worker, /# אמנת agent-company/);                  // project charter
  assert.match(worker, /מדווח ל-`adi`/);
});

test('host-args.json carries the system prompt file when there is one', async () => {
  const { hostArgs, shiftUnit } = await import('../src/shifts.ts');
  const args = hostArgs({ shiftId: 'yoav-3', identity: 'yoav', shiftNo: 3, sessionId: sessionIdFor('yoav', 3), resume: false,
    kind: 'resident', cwd: '/w', socketPath: '/s', taskId: null, unit: shiftUnit('yoav-3'), systemPromptFile: '/state/shifts/yoav-3/system.md' }, '/state');
  assert.equal(args['append-system-prompt-file'], '/state/shifts/yoav-3/system.md');
});
