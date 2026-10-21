// #153: a project that stands still with work open wakes its lead once, and then the manager. The scenario is
// voice-bot on 21/10: he bought credits at 18:37 (Bangkok), the lead ended its turn, the worker rested, nothing moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, type TestEnv } from './helpers.ts';
import { openItems, STALL_AFTER_MS, ESCALATE_AFTER_MS } from '../src/stall-watch.ts';
import { ensureRuntimeIdentity } from '../src/org.ts';

const ORG = `
version: 1
owner: ran
owner_name: רן
owner_gender: male
manager: yoav
monitoring_lead: rotem
timezone: Asia/Bangkok
teams:
  - {id: management, kind: permanent, symbol: account_tree, lead: yoav, members: []}
  - {id: voice-bot, kind: project, project: voice-bot, symbol: call, lead: shachar, members: [gal]}
  - {id: lumo, kind: project, project: lumo, symbol: forum, lead: dana, members: []}
  - {id: nws, kind: project, project: nws, symbol: campaign, lead: matan, members: []}
identities:
  - id: yoav
    name: יואב
    title: מנהל החברה
    symbol: explore
    team: management
    reports_to: ran
    lifecycle: always-on
    resident: true
    automations:
      - {id: stall-watch, what: פרויקט שעומד עם עבודה פתוחה, enabled: true}
  - {id: shachar, name: שחר, title: מנכ"ל voice-bot, symbol: call, team: voice-bot, reports_to: yoav, kind: project, lifecycle: always-on}
  - {id: gal, name: גל, title: קול וקו, symbol: mic, team: voice-bot, reports_to: shachar, kind: project, lifecycle: dormant}
  - {id: dana, name: דנה, title: מנכ"לית לומו, symbol: forum, team: lumo, reports_to: yoav, kind: project, lifecycle: always-on}
  - {id: matan, name: מתן, title: מנכ"ל nws, symbol: campaign, team: nws, reports_to: yoav, kind: project, lifecycle: always-on}
projects:
  - {id: voice-bot, name: הבוט הקולי, status: active, team: voice-bot}
  - {id: lumo, name: לומו, status: active, team: lumo}
  - {id: nws, name: מה חדש בעיר, status: dormant, team: nws}
`;

const CHARTER = (p: string, extra = '', status = 'active') => `---\nproject: ${p}\nstatus: ${status}\nrepo: hive-owner/${p}\n${extra}---\n\n# x\n`;

const OPEN_GAL = `# מה פתוח אצל גל

## הקול החדש בימות
- **מחכה ל-GO בבוקר:** PR 26 ו-PR 27.
- שאלה פתוחה לרן: האם לעבור ליציבות 0.85.

## ישן
- הפתיחה של שיחה 3m3vt.
`;

const MIN = 60_000;
/** 21/10/2026 18:37 in Bangkok (11:37 UTC): task 150 bought the credits and closed. */
const BOUGHT = Date.UTC(2026, 9, 21, 11, 37, 13);

async function stallEnv(files: Record<string, string> = { 'voice-bot': OPEN_GAL, lumo: OPEN_GAL, nws: OPEN_GAL }): Promise<TestEnv> {
  const env = await makeEnv({
    org: ORG,
    projects: { 'voice-bot': CHARTER('voice-bot'), lumo: CHARTER('lumo', 'paused: רן השהה את האפליקציה\n'), nws: CHARTER('nws', '', 'dormant') },
    deps: { openFiles: async (p) => (files[p] ? [{ file: `memory/projects/${p}/open-gal.md`, text: files[p]! }] : []) },
  });
  // Messages stay queued until a test says the turn on them ended: no fake shift in the way of the timing.
  (env.hq.mailbox as unknown as { deliver: () => Promise<void> }).deliver = async () => {};
  env.clock.t = BOUGHT - 20 * MIN;
  return env;
}

/** The lead asked, he answered at `at`, and the lead's turn on it ended. */
function answeredAsk(env: TestEnv, from: string, at: number, question = 'נגמרו הקרדיטים ב-ElevenLabs. לקנות עוד?') {
  env.hq.store.db.prepare(`INSERT INTO asks (id, from_identity, question, state, answer, answered_by, created_at, answered_at)
    VALUES (?, ?, ?, 'answered', 'קניתי', 'owner', ?, ?)`).run(`ask-${from}-${at}`, from, question, at - 15 * MIN, at);
}

function status(env: TestEnv, identity: string, args: Record<string, unknown>) {
  const t = env.hq.store.now();
  env.hq.store.db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES (?, ?, 'status', ?, ?, '{}')`)
    .run(`op-${identity}-${t}`, identity, JSON.stringify(args), t);
}

const fromHq = (env: TestEnv, to: string) => env.hq.store.db.prepare(`SELECT id, body, state FROM messages WHERE from_identity = 'hq' AND to_identity = ? ORDER BY created_at`)
  .all(to) as { id: string; body: string; state: string }[];

/** The lead read the message and ended its turn without doing anything. */
const turnEnded = (env: TestEnv) => env.hq.store.db.prepare(`UPDATE messages SET state = 'handled' WHERE to_identity = 'shachar' AND state IN ('queued','delivered')`).run();

const at = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 21, hh, mm, ss);

/**
 * voice-bot in hq.db on 21/10, 18:24–18:38 Bangkok (11:24–11:38 UTC), the rows that matter: the asks and his answers,
 * task 150 (the worker who bought the credits, its own `blocked` on the way), the lead's report to him at 18:37, gal's
 * messages to the lead, and a system message to the worker of task 27, closed on 20/10, that was never read.
 */
function replay2110(env: TestEnv) {
  const db = env.hq.store.db;
  for (const t of [27, 150]) ensureRuntimeIdentity(env.hq.store, { id: `voice-bot-t${t}`, name: 'עובד', title: 'מפתח', project: 'voice-bot', reports_to: 'shachar' });
  db.prepare(`INSERT INTO tasks (id, project, title, state, identity, created_at, updated_at, started_at) VALUES (27, 'voice-bot', 'ישנה', 'done', 'voice-bot-t27', ?, ?, ?)`)
    .run(at(8, 0) - 86_400_000, at(10, 11) - 86_400_000, at(8, 0) - 86_400_000);
  db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, state, created_at) VALUES ('stale-27', 'hq', 'voice-bot-t27', 'system', 'x', 'delivered', ?)`)
    .run(at(10, 11, 8) - 86_400_000);
  db.prepare(`INSERT INTO asks (id, from_identity, question, state, answer, answered_by, created_at, answered_at) VALUES
    ('ask-1', 'shachar', 'הקרדיטים בחשבון ElevenLabs נגמרו (0 מתוך 363,000)', 'answered', 'אין בעיה אני אוסיף', 'owner', ?, ?),
    ('ask-2', 'shachar', 'ElevenLabs: לעבור ל-Pro, בערך 99$ לחודש עם 600 אלף קרדיטים?', 'answered', 'אני לא רוצה לשלם 100 דולר בחודש', 'owner', ?, ?)`)
    .run(at(11, 24, 59), at(11, 25, 31), at(11, 34, 40), at(11, 35, 44));
  const msg = db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  msg.run('m1', 'gal', 'shachar', 'tell', 'דחוף: הקרדיטים של ElevenLabs נגמרו', 'handled', at(11, 24, 35));
  msg.run('m2', 'gal', 'shachar', 'tell', '(1) אף שיחה לא נפגעה מהמכסה', 'seen', at(11, 26, 38));
  msg.run('m3', 'owner', 'shachar', 'tell', 'אוקיי אני מחכה כבר שתעדכן אותי לגבי החבילה', 'handled', at(11, 34, 10));
  msg.run('m4', 'voice-bot-t150', 'shachar', 'tell', 'קניתי top-up חד-פעמי של 150k קרדיטים', 'seen', at(11, 37, 4));
  msg.run('m5', 'shachar', 'owner', 'tell', 'נקנו 150 אלף קרדיטים. ימות חזר לבוט החדש', 'handled', at(11, 37, 18));
  db.prepare(`INSERT INTO tasks (id, project, title, state, identity, created_at, updated_at, started_at) VALUES (150, 'voice-bot', 'ElevenLabs: לקנות חבילה', 'done', 'voice-bot-t150', ?, ?, ?)`)
    .run(at(11, 27, 54), at(11, 37, 13), at(11, 27, 58));
  const op = db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES (?, ?, ?, ?, ?, '{}')`);
  op.run('o1', 'voice-bot-t150', 'status', JSON.stringify({ state: 'blocked', note: 'מחכה לאישור חבילה מרן דרך שחר' }), at(11, 34, 35));
  op.run('o2', 'voice-bot-t150', 'status', JSON.stringify({ state: 'done', summary: 'נוספו 150 אלף קרדיטים' }), at(11, 37, 7));
  op.run('o3', 'shachar', 'tell', JSON.stringify({ to: 'owner', body: 'נקנו 150 אלף קרדיטים' }), at(11, 37, 18));
  const shift = db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at, ended_at, last_event_at, in_turn) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
  shift.run('shachar-2', 'shachar', 2, 'live', at(7, 26, 36), null, at(11, 37, 21));
  shift.run('gal-11', 'gal', 11, 'ended', at(10, 3, 9), at(10, 28, 43), at(10, 28, 43));
  shift.run('voice-bot-t150-1', 'voice-bot-t150', 1, 'ended', at(11, 27, 58), at(11, 37, 13), at(11, 37, 13));
}

/** Sweeps once a minute until `until` (as hq does). */
async function minutes(env: TestEnv, n: number) {
  for (let i = 0; i < n; i++) { env.clock.advance(MIN); await env.hq.stallWatch.sweep(); }
}

test('openItems: top-level list items, without the closed sections', () => {
  assert.deepEqual(openItems(OPEN_GAL), ['מחכה ל-GO בבוקר: PR 26 ו-PR 27.', 'שאלה פתוחה לרן: האם לעבור ליציבות 0.85.']);
  assert.deepEqual(openItems('# x\n\nאין כרגע כלום.\n'), []);
  assert.deepEqual(openItems('- אין\n'), []);
  assert.deepEqual(openItems('1. אחד\n  - תת-פריט\n## בוצע\n- סגור\n'), ['אחד']);
});

test('21/10 replayed from the store: credits bought at 18:37, nobody went back: the lead hears within minutes, the manager 10 minutes later', async () => {
  const env = await stallEnv();
  try {
    replay2110(env);
    env.clock.t = BOUGHT + MIN; // 18:38: the lead's turn on the purchase is over, the project stands
    await env.hq.stallWatch.sweep();
    assert.equal(fromHq(env, 'shachar').length, 0, 'standing one minute is not a stall');
    await minutes(env, STALL_AFTER_MS / MIN);
    const [alert, ...more] = fromHq(env, 'shachar');
    assert.ok(alert, 'the lead heard');
    assert.equal(more.length, 0);
    assert.ok(env.hq.store.now() < Date.UTC(2026, 9, 21, 11, 51), `before he noticed at 18:51 (${new Date(env.hq.store.now()).toISOString()})`);
    assert.match(alert.body, /הפרויקט `voice-bot` עומד ויש עבודה פתוחה/);
    assert.match(alert.body, /רן ענה ב-18:35 על "ElevenLabs: לעבור ל-Pro/);
    assert.match(alert.body, /`open-gal.md` 2 פריטים פתוחים: מחכה ל-GO בבוקר/);
    assert.doesNotMatch(alert.body, /3m3vt/, 'the closed section is not open work');
    assert.match(alert.body, /תפעיל מחדש או תכתוב למה מחכים/);
    // Its turn on the message: it reads it and ends the turn. That is not a restart.
    await env.hq.stallWatch.sweep();
    turnEnded(env);
    await minutes(env, ESCALATE_AFTER_MS / MIN - 1);
    assert.equal(fromHq(env, 'yoav').length, 0, 'not before 10 minutes');
    await minutes(env, 1);
    const up = fromHq(env, 'yoav');
    assert.equal(up.length, 1, 'the manager heard');
    assert.match(up[0]!.body, /הפרויקט `voice-bot` עומד ויש עבודה פתוחה: רן ענה ב-18:35/);
    assert.match(up[0]!.body, /כתבתי ל-`shachar` ב-18:4\d, ומאז שום דבר לא זז/);
    // Once: an hour more of standing says nothing new to anyone.
    turnEnded(env);
    await minutes(env, 60);
    assert.equal(fromHq(env, 'shachar').length, 1);
    assert.equal(fromHq(env, 'yoav').length, 1);
  } finally { await env.cleanup(); }
});

test('21/10, what he did at 18:51: the lead hands the work on, and the manager is left out of it', async () => {
  const env = await stallEnv();
  try {
    replay2110(env);
    env.clock.t = BOUGHT + MIN;
    await minutes(env, 6);
    assert.equal(fromHq(env, 'shachar').length, 1);
    turnEnded(env);
    env.clock.advance(MIN);
    // A report to him is not handing the work on.
    env.hq.store.db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES ('op-tell-owner', 'shachar', 'tell', ?, ?, '{}')`)
      .run(JSON.stringify({ to: 'owner', body: 'הקרדיטים בפנים' }), env.hq.store.now());
    await minutes(env, ESCALATE_AFTER_MS / MIN);
    assert.equal(fromHq(env, 'yoav').length, 1, 'a report to him is not a restart');
    env.hq.store.db.prepare(`DELETE FROM messages WHERE to_identity = 'yoav'`).run();
    env.hq.store.db.prepare(`DELETE FROM meta WHERE key = 'stall_watch.voice-bot'`).run();
    env.hq.store.db.prepare(`DELETE FROM ops WHERE id = 'op-tell-owner'`).run();
    env.clock.t = BOUGHT + MIN;
    await minutes(env, 6);
    turnEnded(env);
    env.clock.advance(MIN);
    env.hq.store.db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES ('op-tell-gal', 'shachar', 'tell', ?, ?, '{}')`)
      .run(JSON.stringify({ to: 'gal', body: 'יש קרדיטים: תמשיכי את השוואת המודלים' }), env.hq.store.now());
    await minutes(env, 30);
    assert.equal(fromHq(env, 'yoav').length, 0);
  } finally { await env.cleanup(); }
});

test('a paused project (lumo) and a dormant one are never woken', async () => {
  const env = await stallEnv();
  try {
    answeredAsk(env, 'dana', BOUGHT);
    answeredAsk(env, 'matan', BOUGHT);
    env.clock.t = BOUGHT;
    await minutes(env, 30);
    assert.equal(fromHq(env, 'dana').length, 0);
    assert.equal(fromHq(env, 'matan').length, 0);
    assert.equal(fromHq(env, 'yoav').length, 0);
    assert.deepEqual(env.hq.stallWatch.watched().map((w) => w.project), ['voice-bot']);
  } finally { await env.cleanup(); }
});

test('the lead already wrote what it waits for: no message; his next answer makes it news again', async () => {
  const env = await stallEnv();
  try {
    answeredAsk(env, 'shachar', BOUGHT);
    env.clock.t = BOUGHT + MIN;
    status(env, 'shachar', { state: 'blocked', note: 'מחכים שגל תשמע את הדף העיוור בלפטופ' });
    await minutes(env, 40);
    assert.equal(fromHq(env, 'shachar').length, 0, 'it said why it waits');
    // A status without a reason is not a reason.
    const env2 = await stallEnv();
    try {
      answeredAsk(env2, 'shachar', BOUGHT);
      env2.clock.t = BOUGHT + MIN;
      status(env2, 'shachar', { state: 'blocked' });
      await minutes(env2, 7);
      assert.equal(fromHq(env2, 'shachar').length, 1);
    } finally { await env2.cleanup(); }
    // He answers again later: the old note is older than the news.
    answeredAsk(env, 'shachar', env.hq.store.now(), 'לעבור ליציבות 0.85?');
    await minutes(env, 7);
    assert.equal(fromHq(env, 'shachar').length, 1);
  } finally { await env.cleanup(); }
});

test('after the message: a note, or work that restarted, keeps the manager out of it', async () => {
  for (const reaction of ['note', 'task', 'worker'] as const) {
    const env = await stallEnv();
    try {
      answeredAsk(env, 'shachar', BOUGHT);
      env.clock.t = BOUGHT + MIN;
      await minutes(env, 6);
      assert.equal(fromHq(env, 'shachar').length, 1, reaction);
      turnEnded(env);
      env.clock.advance(MIN);
      const now = env.hq.store.now();
      if (reaction === 'note') status(env, 'shachar', { state: 'waiting', note: 'מחכים לתשובה של ElevenLabs על המכסה' });
      if (reaction === 'task') {
        env.hq.store.db.prepare(`INSERT INTO tasks (project, title, state, created_at, updated_at, started_at) VALUES ('voice-bot', 'המשך הקול', 'done', ?, ?, ?)`)
          .run(now, now, now);
      }
      if (reaction === 'worker') {
        env.hq.store.db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at, ended_at, last_event_at) VALUES ('gal-9', 'gal', 9, 'ended', ?, ?, ?)`)
          .run(now, now + MIN, now + MIN);
      }
      await minutes(env, 30);
      assert.equal(fromHq(env, 'yoav').length, 0, reaction);
    } finally { await env.cleanup(); }
  }
});

test('nothing open: a project that stands with no open items and no recent answer is left alone', async () => {
  const env = await stallEnv({});
  try {
    answeredAsk(env, 'shachar', BOUGHT - 60 * MIN);
    env.clock.t = BOUGHT;
    await minutes(env, 30);
    assert.equal(fromHq(env, 'shachar').length, 0);
  } finally { await env.cleanup(); }
});

test('switched off on the board: nothing', async () => {
  const env = await stallEnv();
  try {
    env.hq.store.setToggle('yoav/stall-watch', false);
    answeredAsk(env, 'shachar', BOUGHT);
    env.clock.t = BOUGHT;
    await minutes(env, 20);
    assert.equal(fromHq(env, 'shachar').length, 0);
  } finally { await env.cleanup(); }
});
