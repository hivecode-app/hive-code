import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, ORG_YAML, type TestEnv } from './helpers.ts';
import { validateBlocks, HomeError, STALE_MS, WAKE_EVERY_MS, type HomeRefs } from '../src/home.ts';

const ORG = ORG_YAML.replace(
  '  - {id: ac-ceo, name: שירה, title: מנכ"לית agent-company, symbol: architecture, team: agent-company, reports_to: yoav, kind: project, lifecycle: always-on}',
  `  - id: ac-ceo
    name: שירה
    title: מנכ"לית agent-company
    symbol: architecture
    team: agent-company
    reports_to: yoav
    kind: project
    lifecycle: always-on
    automations:
      - {id: compose-home, what: מרכיבה את הבית, enabled: true}`,
) + `timezone: Asia/Bangkok
projects:
  - {id: agent-company, name: החברה}
  - {id: lumo, name: לומו}
`;

const CHARTER = (p: string, status = 'active') => `---\nproject: ${p}\nstatus: ${status}\nrepo: hive-owner/${p}\n---\n\n# x\n`;

async function homeEnv(): Promise<TestEnv> {
  return makeEnv({ org: ORG, projects: { 'agent-company': CHARTER('agent-company'), lumo: CHARTER('lumo', 'dormant') } });
}

const REFS: HomeRefs = { projects: new Set(['agent-company', 'lumo']), identities: new Set(['yoav', 'ac-ceo']), inbox: new Set([4, 7]), awaiting: new Set([12]), shifts: new Set(['ac-ceo-3']) };
const rejects = (blocks: unknown, why: RegExp) => assert.throws(() => validateBlocks(blocks, REFS), (e: unknown) => e instanceof HomeError && why.test(e.message));

test('validation: the whole vocabulary passes; anything off is a 400 with the reason', () => {
  const all = [
    { type: 'headline', text: 'בוקר שקט', emphasis: 'strong' },
    { type: 'alert', inbox: 4 },
    { type: 'alert', shift: 'ac-ceo-3' },
    { type: 'waiting', inbox: [7, 7] },
    { type: 'awaiting', tasks: [12] },
    { type: 'lanes', projects: ['agent-company', 'lumo'] },
    { type: 'project', project: 'lumo', note: 'מחכה ל-GO' },
    { type: 'people', identities: ['ac-ceo'], caption: 'עובדים עכשיו' },
    { type: 'since', items: ['התמונות עולות', 'הלילה עבר בשקט'] },
    { type: 'note', text: 'שווה לבדוק את הפריסה של 2.6.10', icon: 'rocket_launch', emphasis: 'quiet' },
  ];
  const out = validateBlocks(all, REFS);
  assert.equal(out.length, all.length);
  assert.deepEqual(out[3], { type: 'waiting', inbox: [7] }, 'duplicates folded');
  assert.equal(out[0]!.emphasis, 'strong');

  rejects([], /ריק/);
  rejects({}, /רשימה/);
  rejects([{ type: 'chart', data: [] }], /סוג לא מוכר "chart"/);
  rejects([{ type: 'headline' }], /חסר השדה "text"/);
  rejects([{ type: 'headline', text: 'x', color: 'red' }], /שדה לא מוכר "color"/);
  rejects([{ type: 'headline', text: 'x', emphasis: 'huge' }], /emphasis/);
  rejects([{ type: 'headline', text: 'שורה\nשנייה' }], /שורה אחת/);
  rejects([{ type: 'alert' }], /בדיוק אחד/);
  rejects([{ type: 'alert', inbox: 4, shift: 's' }], /בדיוק אחד/);
  rejects([{ type: 'alert', inbox: 99 }], /לא פתוח/);
  rejects([{ type: 'alert', shift: 'ghost-1' }], /אין משמרת "ghost-1"/);
  rejects([{ type: 'waiting', inbox: [] }], /לא ריקה/);
  rejects([{ type: 'awaiting', tasks: [13] }], /לא ב"מה לבדוק"/);
  rejects([{ type: 'lanes', projects: ['nope'] }], /אין פרויקט "nope"/);
  rejects([{ type: 'project', project: 'nope' }], /אין פרויקט/);
  rejects([{ type: 'people', identities: ['ghost'] }], /אין עובד "ghost"/);
  rejects([{ type: 'since', items: ['א', 'ב', 'ג', 'ד'] }], /עד 3/);
  rejects([{ type: 'note', text: 'x', icon: '🚀' }], /Material Symbol/);
  rejects(Array.from({ length: 13 }, () => ({ type: 'headline', text: 'x' })), /יותר מדי/);
});

test('fallback: the default with no recipe, the agent one while fresh, the default again when stale or invalid', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    const go = hq.inbox.add({ kind: 'go', title: 'GO: hq', from_identity: 'ac-ceo', blocking: true });
    let cur = hq.home.current();
    assert.equal(cur.source, 'default');
    assert.equal(cur.fallback, 'none');
    assert.deepEqual(cur.blocks.map((b) => b.type), ['waiting', 'lanes', 'project'], 'dormant lumo has no lane and no line');
    assert.deepEqual(cur.blocks[0], { type: 'waiting', inbox: [go.id] });
    // "מה לבדוק" comes right after what waits for him, when there is something in it.
    const t = hq.scheduler.addTask({ title: 'תמונות', project: 'agent-company' });
    hq.awaiting.mark(t.id, { awaiting: 'check', awaiting_note: 'לפתוח תמונה מהטלפון' }, 'ac-ceo');
    assert.deepEqual(hq.home.current().blocks.slice(0, 2), [{ type: 'waiting', inbox: [go.id] }, { type: 'awaiting', tasks: [t.id] }]);
    hq.home.compose([{ type: 'awaiting', tasks: [t.id] }], 'ac-ceo');
    hq.awaiting.clear(t.id, 'owner', 'checked');
    assert.deepEqual(hq.home.current().blocks.map((b) => b.type), ['waiting'], 'checked: gone from the recipe too');

    const r = hq.home.compose([{ type: 'headline', text: 'יום עמוס' }, { type: 'project', project: 'lumo' }], 'ac-ceo', 'בדיקה');
    cur = hq.home.current();
    assert.equal(cur.source, 'agent');
    assert.equal(cur.version, r.version);
    assert.equal(cur.composed_by, 'ac-ceo');
    // Live data wins: the blocking GO nobody placed is put in, after the headline.
    assert.deepEqual(cur.blocks.map((b) => b.type), ['headline', 'waiting', 'project']);

    clock.advance(STALE_MS + 1);
    cur = hq.home.current();
    assert.equal(cur.source, 'default');
    assert.equal(cur.fallback, 'stale');
    assert.equal(cur.version, r.version);

    hq.home.compose([{ type: 'project', project: 'lumo' }], 'ac-ceo');
    // The project left the contract after composition: the stored recipe is no longer valid.
    hq.store.db.prepare(`UPDATE home_recipes SET blocks = ? WHERE version = (SELECT MAX(version) FROM home_recipes)`)
      .run(JSON.stringify([{ type: 'project', project: 'gone' }]));
    assert.equal(hq.home.current().fallback, 'invalid');

    hq.home.compose([{ type: 'headline', text: 'שקט' }], 'ac-ceo');
    hq.store.setToggle('ac-ceo/compose-home', false);
    assert.equal(hq.home.current().fallback, 'off', 'switched off: the default stays');
  } finally { await env.cleanup(); }
});

test('a block whose reference closed disappears; a list keeps what is still open', async () => {
  const env = await homeEnv();
  try {
    const { hq } = env;
    const a = hq.inbox.add({ kind: 'incident', title: 'תקלה', from_identity: 'rotem', urgency: 'urgent' });
    const b = hq.inbox.add({ kind: 'go', title: 'GO א', from_identity: 'ac-ceo' });
    const c = hq.inbox.add({ kind: 'go', title: 'GO ב', from_identity: 'ac-ceo' });
    hq.home.compose([{ type: 'alert', inbox: a.id }, { type: 'waiting', inbox: [b.id, c.id] }, { type: 'note', text: 'הערה', icon: 'info' }], 'ac-ceo');
    hq.inbox.resolve(a.id);
    hq.inbox.resolve(b.id);
    assert.deepEqual(hq.home.current().blocks, [{ type: 'waiting', inbox: [c.id] }, { type: 'note', text: 'הערה', icon: 'info' }]);
    hq.inbox.resolve(c.id);
    assert.deepEqual(hq.home.current().blocks.map((x) => x.type), ['note']);
    assert.equal(hq.home.current().source, 'agent', 'pruning is not a reason to drop the recipe');
  } finally { await env.cleanup(); }
});

const wakes = (env: TestEnv) => env.hq.store.db.prepare(`SELECT body FROM messages WHERE to_identity = 'ac-ceo' AND kind = 'system' AND id LIKE 'home-wake-%'
  ORDER BY created_at`).all() as { body: string }[];

test('the composer is woken on what matters, at most once per 3 minutes, with what happened since', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    hq.home.sweep(); // hq.started on boot counts as a deploy
    assert.equal(wakes(env).length, 1);
    assert.match(wakes(env)[0]!.body, /hq עלה מחדש/);
    const t = hq.scheduler.addTask({ title: 'תמונות בצ\'אט', project: 'agent-company' });
    hq.store.db.prepare('UPDATE tasks SET summary = ? WHERE id = ?').run('התמונות בצ\'אט עולות גם מהטלפון', t.id);
    hq.store.emit('task.state', null, { id: t.id, state: 'done' });
    hq.inbox.add({ kind: 'go', title: 'GO: פריסה', headline: 'עדכון לאפליקציה', from_identity: 'ac-ceo' });
    assert.equal(hq.home.sweep(), false, 'within 3 minutes of the last wake');
    clock.advance(WAKE_EVERY_MS);
    assert.equal(hq.home.sweep(), true);
    const body = wakes(env)[1]!.body;
    assert.match(body, /משימה הסתיימה: התמונות בצ'אט עולות גם מהטלפון/);
    assert.match(body, /מחכה לרן: עדכון לאפליקציה/);
    assert.match(body, /compose_home/);
    clock.advance(WAKE_EVERY_MS);
    assert.equal(hq.home.sweep(), false, 'nothing new, nobody woken');

    hq.store.setToggle('ac-ceo/compose-home', false);
    hq.inbox.add({ kind: 'incident', title: 'נפל', from_identity: 'rotem' });
    clock.advance(WAKE_EVERY_MS);
    assert.equal(hq.home.sweep(), false, 'switched off');
    assert.equal(wakes(env).length, 2);
  } finally { await env.cleanup(); }
});

test('night: only an incident or a new "waiting for you" wakes; the rest goes at 07:00 or when he opens the app', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    hq.home.sweep();
    // 09:00 UTC = 16:00 in Bangkok; the night started now, so the morning is 07:00 tomorrow (00:00 UTC).
    hq.store.db.prepare('INSERT INTO nights (started_at) VALUES (?)').run(clock.now());
    assert.equal(hq.home.quiet(), true);
    const t = hq.scheduler.addTask({ title: 'עבודת לילה', project: 'agent-company' });
    hq.store.emit('task.state', null, { id: t.id, state: 'running', shift: 'x-1' });
    hq.store.emit('task.state', null, { id: t.id, state: 'done' });
    clock.advance(WAKE_EVERY_MS);
    assert.equal(hq.home.sweep(), false, 'a finished task waits for the morning');

    hq.inbox.add({ kind: 'incident', title: 'האתר נפל', from_identity: 'rotem', urgency: 'urgent' });
    assert.equal(hq.home.sweep(), true, 'an incident wakes at night');
    const body = wakes(env).at(-1)!.body;
    assert.match(body, /תקלה: האתר נפל/);
    assert.match(body, /משימה הסתיימה: עבודת לילה/, 'what was held goes with it');
    assert.doesNotMatch(body, /משימה התחילה/, 'a task that started at night is not news');

    hq.store.emit('task.state', null, { id: t.id, state: 'done' });
    clock.advance(WAKE_EVERY_MS);
    assert.equal(hq.home.sweep(), false);
    hq.home.opened();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(wakes(env).at(-1)!.body, /משימה הסתיימה/, 'he opened the app: composed now');

    hq.store.emit('task.state', null, { id: t.id, state: 'done' });
    clock.t = Date.UTC(2026, 9, 20, 23, 59);
    assert.equal(hq.home.sweep(), false, '06:59 in Bangkok');
    clock.t = Date.UTC(2026, 9, 21, 0, 0);
    assert.equal(hq.home.quiet(), false);
    assert.equal(hq.home.sweep(), true, '07:00: the morning composition');
  } finally { await env.cleanup(); }
});

test('compose_home over MCP: only the composer and the manager; a bad recipe comes back with the reason', async () => {
  const env = await homeEnv();
  try {
    const { hq } = env;
    const op = (identity: string, id: string, blocks: unknown) => hq.ingest.op({ id, v: 1, ts: '', identity, shift: `${identity}-1`, sessionId: null, op: 'compose_home', args: { blocks, reason: 'בדיקה' } });
    const ack = op('ac-ceo', 'c-1', [{ type: 'headline', text: 'בוקר שקט' }]);
    assert.equal(ack.ok, true);
    assert.equal(hq.home.current().composed_by, 'ac-ceo');
    op('yoav', 'c-2', [{ type: 'headline', text: 'יואב סידר' }]);
    assert.equal(hq.home.current().composed_by, 'yoav');
    assert.throws(() => op('eli', 'c-3', [{ type: 'headline', text: 'x' }]), /may not compose/);
    assert.throws(() => op('ac-ceo', 'c-4', [{ type: 'chart' }]), /סוג לא מוכר/);
    const told = hq.store.db.prepare(`SELECT body FROM messages WHERE id = 'c-4-rejected'`).get() as { body: string };
    assert.match(told.body, /המתכון לא נשמר: בלוק 1: סוג לא מוכר "chart"/);
  } finally { await env.cleanup(); }
});
