import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ensureRuntimeIdentity, listProjects, parseOrg, renameTaskWorkers, syncOrg, taskWorkerName } from '../src/org.ts';
import { sessionIdFor, uuidv5 } from '../src/proc.ts';
import { ORG_YAML } from './helpers.ts';
import { readFileSync, writeFileSync } from 'node:fs';

// The example company (fixtures/README.md): a whole contract, as a company's own repo carries it.
const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'company-home', 'company');

test('store: WAL, migrations idempotent across reopen, toggles seeded once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-store-'));
  try {
    const path = join(dir, 'hq.db');
    const s1 = new Store(path);
    assert.equal(s1.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(s1.schemaVersion, 17);
    s1.setToggle('probes', false);
    s1.close();
    const s2 = new Store(path);
    assert.equal(s2.schemaVersion, 17);
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

test('a whole contract parses: org.yaml of the example company (fixtures/)', () => {
  const file = join(FIXTURE, 'org.yaml');
  const { identities, automations } = parseOrg(readFileSync(file, 'utf8'), [], 'gal');
  const by = Object.fromEntries(identities.map((r) => [r.id, r]));
  assert.equal(by.gal?.lifecycle, 'resident');
  assert.equal(by.hadar?.reports_to, 'gal');
  assert.ok(automations.some((a) => a.key === 'hadar/prod-probes'));
});

test('projects for the board: org.yaml order and names, the charter\'s status wins, no charter falls back to org.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-projects-'));
  try {
    assert.deepEqual(listProjects(dir), [], 'no org.yaml');
    mkdirSync(join(dir, 'projects'));
    writeFileSync(join(dir, 'org.yaml'), [
      'projects:',
      '  - id: co', '    status: dormant', '    team: co',
      '  - id: shop', '    name: החנות', '    status: dormant', '    team: shop-team',
      '  - id: lost', '    status: active',
      '  - status: active',
    ].join('\n'));
    writeFileSync(join(dir, 'projects', 'co.md'), '---\nproject: co\nstatus: active\n---\n# co\n');
    writeFileSync(join(dir, 'projects', 'shop.md'), '---\nproject: shop\nstatus: dormant\n---\n# shop\n');
    assert.deepEqual(listProjects(dir), [
      { id: 'co', name: null, status: 'active', team: 'co' },
      { id: 'shop', name: 'החנות', status: 'dormant', team: 'shop-team' },
      { id: 'lost', name: null, status: 'active', team: null },
    ]);
    writeFileSync(join(dir, 'org.yaml'), 'projects: [');
    assert.deepEqual(listProjects(dir), [], 'a broken org.yaml is an empty list, not a crash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a whole contract lists its projects with their charter status (the example company)', () => {
  const projects = listProjects(FIXTURE);
  assert.ok(projects.some((p) => p.id === 'engine' && p.status === 'active'));
  assert.ok(projects.some((p) => p.id === 'old-site' && p.status === 'dormant'));
  // The owner's names, not the repo ids.
  const name = (id: string) => projects.find((p) => p.id === id)?.name;
  assert.deepEqual([name('engine'), name('shop'), name('support-bot')], ['המנוע', 'החנות', 'בוט התמיכה']);
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
  const companyDir = FIXTURE;
  const base = { symbol: '', team: null, team_kind: 'permanent', project: null, reports_to: null, lifecycle: 'resident', source: 'org', active: 1, data: '{}', updated_at: 0 };
  const yoav = buildSystemPrompt(companyDir, { ...base, id: 'gal', name: 'גל', title: 'מנהל החברה' }, 'gal');
  assert.match(yoav, /אתה גל, מנהל החברה/);
  assert.match(yoav, /# גל · מנהל החברה/);                      // the dossier itself
  assert.match(yoav, /## הרשימה המלאה של מה שאסור/);            // Authority, verbatim (directives.md)
  assert.match(yoav, /`tell`/);
  assert.match(yoav, /ה-identity של שירה הוא `owner`/);
  // chat.md §2.3א: with the owner the text is the reply; no tell back, no self-narration or delivery internals.
  assert.match(yoav, /\*\*הטקסט שאתה כותב הוא התשובה\.\*\*/);
  assert.match(yoav, /\*\*לא עונים לה ב-`tell`\.\*\*/);   // the owner of the example company is a woman
  assert.match(yoav, /לא מסכמים לעצמך מה עשית/);
  assert.match(yoav, /ההודעה נכנסה לתור המסירה/);
  assert.doesNotMatch(yoav, /טקסט רגיל בתשובה שלך לא מגיע לאף אחד/, 'the old rule that made every reply a tell');
  const worker = buildSystemPrompt(companyDir, { ...base, id: 'engine-t7', name: 'דנה', title: 'מפתחת', team_kind: 'task',
    project: 'engine', reports_to: 'ron', lifecycle: 'ephemeral', source: 'runtime' }, 'gal');
  assert.match(worker, /# אתה דנה, מפתחת, בצוות משימה \(`engine-t7`\)/);
  // #51: Hebrew to everyone, titles included, even when the message came in English.
  assert.match(worker, /\*\*עברית בכל הודעה\*\*: לשירה, לגל ולכל עובד, גם כשכתבו לך באנגלית/);
  assert.match(worker, /`open_team`\) וטיקטים \(`open_ticket`\) בעברית/);
  assert.match(worker, /gh pr merge --squash/);
  // The worker runs in another project's checkout: the company skills by absolute path.
  assert.ok(worker.includes(`\`${join(companyDir, 'skills', 'reviewer', 'SKILL.md')}\``), 'absolute reviewer skill path');
  assert.ok(worker.includes(`\`${join(companyDir, 'skills', 'ship', 'SKILL.md')}\``), 'absolute ship skill path');
  assert.match(worker, /`engine-ci`/);
  assert.match(worker, /# אמנת המנוע/);                          // project charter
  assert.match(worker, /מדווח ל-`ron`/);
  // A helper eli opens has no project: the errand itself, no worktree/PR, outward acts need the owner (#24).
  const task = { ...base, team_kind: 'task', lifecycle: 'ephemeral', source: 'runtime' };
  const eli = { ...base, id: 'eli', name: 'אלי', title: 'ראש הצוות האישי', team: 'personal', lifecycle: 'lead' };
  const helper = buildSystemPrompt(companyDir, { ...task, id: 'company-t9', name: 'איתי', title: 'עוזר אישי', reports_to: 'eli' }, 'gal', eli);
  assert.match(helper, /# אתה איתי, עוזר אישי: עוזר חד-פעמי/);
  assert.match(helper, /`eli` פתח אותך/);
  assert.match(helper, /כלפי אנשים בחוץ/);
  assert.doesNotMatch(helper.split('\n---\n')[0]!, /git worktree|gh pr merge/); // company.md below still mentions them
  // Any other task without a project (noga's contract PRs, an owner task with no project) keeps the code-task rules.
  const noga = { ...base, id: 'noga', name: 'נגה', title: 'ראש מחלקת השיפור', team: 'improvement', lifecycle: 'lead' };
  for (const opener of [noga, undefined]) {
    const t = buildSystemPrompt(companyDir, { ...task, id: 'company-t10', name: 't10', title: 'x', reports_to: opener?.id ?? 'gal' }, 'gal', opener);
    assert.match(t, /צוות משימה/);
    assert.doesNotMatch(t, /עוזר חד-פעמי/);
  }
});

test('host-args.json carries the system prompt file when there is one', async () => {
  const { hostArgs, shiftUnit } = await import('../src/shifts.ts');
  const args = hostArgs({ shiftId: 'yoav-3', identity: 'yoav', shiftNo: 3, sessionId: sessionIdFor('yoav', 3), resume: false,
    kind: 'resident', cwd: '/w', socketPath: '/s', taskId: null, unit: shiftUnit('yoav-3'), systemPromptFile: '/state/shifts/yoav-3/system.md' }, '/state');
  assert.equal(args['append-system-prompt-file'], '/state/shifts/yoav-3/system.md');
});

test('task workers get a human name and a title, never one a live worker already has (#51)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-names-'));
  const store = new Store(join(dir, 'hq.db'));
  const open = (id: string, n: number, state = 'running') => {
    store.db.prepare(`INSERT INTO tasks (title, state, identity, created_at, updated_at) VALUES (?, ?, ?, 0, 0)`).run(`משימה ${n}`, state, id);
  };
  try {
    const a = taskWorkerName(store, 0);
    assert.deepEqual(a, { name: 'נעמה', title: 'מפתחת' });
    ensureRuntimeIdentity(store, { id: 'agent-company-t0', ...a, project: 'agent-company', reports_to: 'adi' });
    assert.equal(taskWorkerName(store, 0).name, 'נעמה', 'a worker with no open task does not hold its name');
    open('agent-company-t0', 0);
    assert.deepEqual(taskWorkerName(store, 0), { name: 'איתי', title: 'מפתח' }, 'נעמה is taken: the next one');
    assert.deepEqual(taskWorkerName(store, 1, true), { name: 'איתי', title: 'עוזר אישי' });
    assert.equal(taskWorkerName(store, 24).name, 'איתי', 'wraps around the pool');
    // 25 open workers at once: all names distinct, the 25th gets a suffix
    const names = new Set(['נעמה']);
    for (let i = 1; i <= 24; i++) {
      const w = taskWorkerName(store, i);
      ensureRuntimeIdentity(store, { id: `agent-company-t${i}`, ...w, project: 'agent-company', reports_to: 'adi' });
      open(`agent-company-t${i}`, i);
      names.add(w.name);
    }
    assert.equal(names.size, 25);
    assert.ok(names.has('נעמה ב׳'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a task worker never gets a standing identity\'s name, one added to org.yaml later included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-names-'));
  const store = new Store(join(dir, 'hq.db'));
  const standing = (id: string, name: string) => store.db.prepare(`INSERT INTO identities (id, name, title, symbol, team, team_kind, project,
      reports_to, lifecycle, source, active, data, updated_at) VALUES (?, ?, 'ראש צוות', '', 'x', 'project', NULL, 'yoav', 'lead', 'org', 1, '{}', 0)`).run(id, name);
  try {
    // A whole contract (the example company): no pool name is a standing identity's, for every task id.
    syncOrg(store, FIXTURE, [], 'gal');
    const names = new Set((store.db.prepare(`SELECT name FROM identities WHERE source = 'org'`).all() as { name: string }[]).map((r) => r.name));
    assert.ok(names.has('גל') && names.has('הדר') && names.has('אביב'));
    assert.ok(names.has('מיכל'), 'מיכל is a standing identity in support-bot');
    for (let i = 0; i < 60; i++) assert.ok(!names.has(taskWorkerName(store, i).name), `task ${i}: ${taskWorkerName(store, i).name}`);
    // A task worker named מיכל from before she joined org.yaml: renamed at load, so the name is hers alone.
    ensureRuntimeIdentity(store, { id: 'lumo-bot-t7', name: 'מיכל', title: 'מפתחת', project: 'lumo-bot', reports_to: 'boaz' });
    assert.equal(renameTaskWorkers(store), 1);
    const renamed = store.db.prepare(`SELECT name, title FROM identities WHERE id = 'lumo-bot-t7'`).get() as { name: string; title: string };
    assert.ok(!names.has(renamed.name.split(' ')[0]!), renamed.name);
    assert.match(renamed.title, /^מפתח/);
    // A standing identity added later with a pool name: that name is out from now on, suffixes included.
    standing('naama', 'נעמה');
    for (let i = 0; i < 60; i++) assert.notEqual(taskWorkerName(store, i).name.split(' ')[0], 'נעמה');
    assert.equal(taskWorkerName(store, 0).name, 'איתי');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('task workers that carry a standing identity\'s name get another one, and keep their role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-names-'));
  const store = new Store(join(dir, 'hq.db'));
  try {
    store.db.prepare(`INSERT INTO identities (id, name, title, symbol, team, team_kind, project, reports_to, lifecycle, source, active, data, updated_at)
      VALUES ('dana', 'דנה', 'מנכ"לית לומו', '', 'lumo', 'project', 'lumo', 'yoav', 'lead', 'org', 1, '{}', 0)`).run();
    ensureRuntimeIdentity(store, { id: 'lumo-t22', name: 'דנה', title: 'מפתחת', project: 'lumo', reports_to: 'dana' });
    ensureRuntimeIdentity(store, { id: 'company-t9', name: 'דנה ב׳', title: 'עוזרת אישית', project: null, reports_to: 'eli' });
    ensureRuntimeIdentity(store, { id: 'lumo-t23', name: 'אורית', title: 'מפתחת', project: 'lumo', reports_to: 'dana' });
    assert.equal(renameTaskWorkers(store), 2);
    const row = (id: string) => store.db.prepare('SELECT name, title FROM identities WHERE id = ?').get(id) as { name: string; title: string };
    assert.notEqual(row('lumo-t22').name, 'דנה');
    assert.match(row('lumo-t22').title, /^מפתח/);
    assert.doesNotMatch(row('company-t9').name, /^דנה/);
    assert.match(row('company-t9').title, /^עוזר/);
    assert.equal(row('lumo-t23').name, 'אורית', 'a name no standing identity has stays');
    assert.equal(renameTaskWorkers(store), 0, 'idempotent');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy t<N> workers are renamed once at startup, helpers as helpers (#51)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-names-'));
  const store = new Store(join(dir, 'hq.db'));
  try {
    store.db.prepare(`INSERT INTO identities (id, name, title, symbol, team, team_kind, project, reports_to, lifecycle, source, active, data, updated_at)
      VALUES ('eli', 'אלי', 'ראש הצוות האישי', '', 'personal', 'personal', NULL, 'owner', 'lead', 'org', 1, '{}', 0)`).run();
    ensureRuntimeIdentity(store, { id: 'agent-company-t12', name: 't12', title: 'Tab handoff into hq', project: 'agent-company', reports_to: 'yoav' });
    ensureRuntimeIdentity(store, { id: 'company-t14', name: 't14', title: 'טופס', project: null, reports_to: 'eli' });
    assert.equal(renameTaskWorkers(store), 2);
    const row = (id: string) => store.db.prepare('SELECT name, title FROM identities WHERE id = ?').get(id) as { name: string; title: string };
    assert.doesNotMatch(row('agent-company-t12').name, /^t\d/);
    assert.match(row('agent-company-t12').title, /^מפתח/);
    assert.match(row('company-t14').title, /^עוזר/);
    assert.equal(renameTaskWorkers(store), 0, 'idempotent');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
