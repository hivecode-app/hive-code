import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { makeEnv, until } from './helpers.ts';
import { search } from '../src/search.ts';
import { TaskCatalog } from '../src/task-product.ts';
import { notificationTitle, productPreferences, systemCopy, systemText } from '../src/i18n.ts';

test('search: names, roles, projects, tasks and owner messages; literal query and private mail exclusion', async () => {
  const env = await makeEnv({ noStart: true, projects: { 'agent-company': '---\nproject: agent-company\nstatus: active\n---\n# Company' } });
  try {
    const { hq } = env;
    writeFileSync(join(env.cfg.companyDir, 'org.yaml'), readFileSync(join(env.cfg.companyDir, 'org.yaml'), 'utf8') + '\nprojects:\n  - {id: agent-company, name: Company}\n');
    await hq.start({ timers: false });
    hq.store.db.prepare('UPDATE identities SET name = ?, title = ? WHERE id = ?').run('מירה', 'ראשת צוות יומן שטח', 'eli');
    hq.store.db.prepare(`INSERT INTO tasks (title, project, identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('המפה קורסת', 'agent-company', 'eli', 1, 1);
    const put = hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    put.run('owner-visible', 'eli', 'owner', 'המפה קורסת', 'tell', 1);
    put.run('private', 'eli', 'amit', 'המפה קורסת SECRET', 'tell', 2);
    put.run('system', 'hq', 'owner', 'המפה קורסת internal', 'system', 3);
    assert.equal(search(hq, 'מירה').results[0]?.id, 'eli');
    assert.equal(search(hq, 'ראשת צוות יומן שטח').results[0]?.kind, 'person');
    const hits = search(hq, 'המפה קורסת').results;
    assert(hits.some((r) => r.kind === 'task'));
    assert.deepEqual(hits.filter((r) => r.kind === 'message').map((r) => r.id), ['owner-visible']);
    assert(search(hq, 'agent-company').results.some((r) => r.kind === 'project'));
    assert.deepEqual(search(hq, '%').results, []);
    assert.deepEqual(search(hq, "' OR 1=1 --").results, []);
    assert.deepEqual(search(hq, '   ').results, []);
    assert(!JSON.stringify(hits).includes('SECRET'));
  } finally { await env.cleanup(); }
});

test('search: project names instead of ids, a stage per task, open work before finished', async () => {
  const env = await makeEnv({ noStart: true, projects: { 'field-log': '---\nproject: field-log\nstatus: active\n---\n# Field' } });
  try {
    const { hq } = env;
    writeFileSync(join(env.cfg.companyDir, 'org.yaml'), readFileSync(join(env.cfg.companyDir, 'org.yaml'), 'utf8') + '\nprojects:\n  - {id: field-log, name: יומן שטח}\n');
    await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const add = hq.store.db.prepare(`INSERT INTO tasks (title, project, identity, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    add.run('מפה ישנה', 'field-log', 'eli', 'done', 1, 50);
    add.run('מפה חדשה', 'field-log', 'eli', 'running', 1, 10);
    add.run('מפה מוצעת', 'field-log', null, 'proposal', 1, 5);
    const tasks = search(hq, 'מפה').results.filter((r) => r.kind === 'task');
    assert.deepEqual(tasks.map((t) => t.title), ['מפה חדשה', 'מפה מוצעת', 'מפה ישנה']);
    assert(tasks.every((t) => t.project_name === 'יומן שטח' && t.subtitle === 'יומן שטח'));
    assert.equal(tasks[0]!.stage, 'development'); assert.equal(tasks[1]!.stage, 'proposal');
    assert.equal(tasks[2]!.outcome, 'completed'); assert.equal(tasks[0]!.outcome, null);
    const project = search(hq, 'יומן').results.find((r) => r.kind === 'project')!;
    assert.equal(project.title, 'יומן שטח'); assert.equal(project.open_tasks, 1);
    assert(!JSON.stringify(search(hq, 'מפה').results).includes('"subtitle":"field-log"'));

    // People: active before old; a project's lead reports to someone even with nobody active under them yet;
    // a worker is in the lead's team and carries the task in hand with its stage.
    const who = hq.store.db.prepare(`INSERT INTO identities (id, name, title, team_kind, project, reports_to, lifecycle, source, active, updated_at)
      VALUES (?, ?, ?, ?, 'field-log', ?, ?, ?, ?, 0)`);
    who.run('mira', 'שדה מירה', 'ראשת צוות', 'project', 'yoav', 'lead', 'org', 1);
    who.run('itai', 'שדה איתי', 'מפתח', 'task', 'mira', 'ephemeral', 'runtime', 1);
    who.run('gone', 'שדה ותיק', 'מפתח', 'task', 'mira', 'ephemeral', 'runtime', 0);
    hq.store.db.prepare(`UPDATE tasks SET identity = 'itai' WHERE title = 'מפה חדשה'`).run();
    const people = search(hq, 'שדה').results.filter((r) => r.kind === 'person');
    assert.equal(people.at(-1)!.id, 'gone');
    const mira = people.find((p) => p.id === 'mira')!, itai = people.find((p) => p.id === 'itai')!;
    hq.store.db.prepare(`UPDATE identities SET active = 0 WHERE id = 'itai'`).run();
    assert.equal(search(hq, 'שדה').results.find((p) => p.id === 'mira')!.leads, true, 'a lead with nobody active under them');
    assert.equal(mira.leads, true);
    assert.equal(itai.leads, false); assert.equal(itai.lead_name, 'שדה מירה'); assert.equal(itai.project_name, 'יומן שטח');
    assert.deepEqual(itai.now_task && { title: itai.now_task.title, stage: itai.now_task.stage }, { title: 'מפה חדשה', stage: 'development' });

    // The project context is kept for a few seconds, but its open requests are read each time.
    const catalog = new TaskCatalog(hq), first = catalog.projectContext(['field-log']);
    const mine = hq.inbox.mine.bind(hq.inbox);
    hq.inbox.mine = () => [{ id: 'i1', kind: 'go', headline: 'לשחרר', title: 'לשחרר', from_identity: 'itai', created_at: 1, ref: null }] as never;
    try {
      const second = catalog.projectContext(['field-log']);
      assert.equal(second.charters, first.charters, 'charters come from the cache');
      assert.deepEqual(second.requests.map((r) => r.id), ['i1']);
    } finally { hq.inbox.mine = mine; }
  } finally { await env.cleanup(); }
});

test('product preferences and system templates are bilingual with English defaults', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    assert.deepEqual(productPreferences(env.cfg.companyDir), { owner_language: 'en', advanced_mode: false });
    const file = join(env.cfg.companyDir, 'org.yaml');
    writeFileSync(file, readFileSync(file, 'utf8') + '\nowner_language: he\nadvanced_mode: true\n');
    assert.deepEqual(productPreferences(env.cfg.companyDir), { owner_language: 'he', advanced_mode: true });
    for (const c of Object.values(systemCopy)) { assert(c.en); assert(c.he); }
    assert.equal(systemText('done', 'en', 'Map fix'), 'Done: Map fix');
    assert.equal(systemText('done', 'he', 'תיקון במפה'), 'הסתיים: תיקון במפה');
    assert.equal(systemText('release', 'en', 'Map fix'), 'Release Map fix?');
    assert.equal(notificationTitle({kind: 'go', title: 'GO internal', headline: 'Map fix', action: 'release'}, 'en'), 'Release Map fix?');
    assert.equal(notificationTitle({kind: 'go', title: 'GO internal', headline: null}, 'he'), 'לאשר את הפעולה?');
  } finally { await env.cleanup(); }
});

test('search API requires authentication and board carries server language defaults', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const base = `http://127.0.0.1:${env.hq.port}`;
    assert.equal((await fetch(`${base}/api/search?q=eli`)).status, 401);
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/api/search?q=eli`, { headers })).status, 200);
    const board = await (await fetch(`${base}/api/board`, { headers })).json() as Record<string, unknown>;
    assert.equal(board.owner_language, 'en'); assert.equal(board.advanced_mode, false);
  } finally { await env.cleanup(); }
});


test('actual web push title follows owner_language without changing notification policy', async () => {
  const env = await makeEnv();
  try {
    env.hq.pusher.subscribe({endpoint: 'https://push.example/test', keys: {p256dh: 'x', auth: 'y'}});
    env.hq.inbox.add({kind: 'go', from_identity: 'eli', title: 'GO internal', headline: 'Map fix', blocking: true});
    await until(() => env.webPushes.length === 1);
    assert.equal((JSON.parse(env.webPushes[0]!.payload) as {title: string}).title, 'Approve Map fix?');
    env.hq.store.setToggle('night', true);
    const quiet = env.hq.inbox.add({kind: 'go', from_identity: 'eli', title: 'GO internal', headline: 'Quiet fix', blocking: true});
    await env.hq.pusher.notify(quiet);
    assert.equal(env.webPushes.length, 1, 'localized titles preserve the merged night policy');
  } finally { await env.cleanup(); }
});
