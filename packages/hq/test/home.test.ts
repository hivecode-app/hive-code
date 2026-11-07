import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, ORG_YAML, type TestEnv } from './helpers.ts';
import { buildRoutes } from '../src/api.ts';
import { validateBlocks, sentence, HomeError, STALE_MS, VISIT_GAP_MS, type HomeFacts, type HomeRefs } from '../src/home.ts';

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
      - {id: home-headline, what: hq כותב את המשפט בראש הבית, enabled: true}`,
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
    { type: 'quiet', projects: ['lumo'] },
    { type: 'people', identities: ['ac-ceo'], caption: 'עובדים עכשיו' },
    { type: 'since', items: ['התמונות עולות', 'הלילה עבר בשקט'] },
    { type: 'note', text: 'שווה לבדוק את הפריסה של 2.6.10', icon: 'rocket_launch', emphasis: 'quiet' },
  ];
  const out = validateBlocks(all, REFS);
  // Decisions are the app's tab (task 306): waiting, asked and awaiting from an older composer pass and are skipped; an alert on an inbox item too.
  assert.deepEqual(out.map((b) => b.type), all.map((b) => b.type).filter((t) => !['waiting', 'asked', 'awaiting'].includes(t)).filter((t, i, a) => !(t === 'alert' && a.indexOf(t) === i)));
  assert.equal(out[0]!.emphasis, 'strong');
  assert.deepEqual(out.find((b) => b.type === 'since'), { type: 'since', items: [{ text: 'התמונות עולות' }, { text: 'הלילה עבר בשקט' }] }, 'a sentence is {text}');

  rejects([], /ריק/);
  rejects({}, /רשימה/);
  rejects([{ type: 'chart', data: [] }], /סוג לא מוכר "chart"/);
  rejects([{ type: 'headline' }], /חסר השדה "text"/);
  rejects([{ type: 'headline', text: 'x', color: 'red' }], /שדה לא מוכר "color"/);
  rejects([{ type: 'headline', text: 'x', emphasis: 'huge' }], /emphasis/);
  rejects([{ type: 'headline', text: 'שורה\nשנייה' }], /שורה אחת/);
  rejects([{ type: 'alert' }], /בדיוק אחד/);
  rejects([{ type: 'alert', inbox: 4, shift: 's' }], /בדיוק אחד/);
  rejects([{ type: 'alert', shift: 'ghost-1' }], /אין משמרת "ghost-1"/);
  rejects([{ type: 'lanes', projects: ['nope'] }], /אין פרויקט "nope"/);
  rejects([{ type: 'project', project: 'nope' }], /אין פרויקט/);
  rejects([{ type: 'quiet', projects: ['nope'] }], /אין פרויקט "nope"/);
  rejects([{ type: 'people', identities: ['ghost'] }], /אין עובד "ghost"/);
  rejects([{ type: 'since', items: ['א', 'ב', 'ג', 'ד'] }], /עד 3/);
  rejects([{ type: 'since', items: [{ text: 'א', task: 'x' }] }], /מזהה משימה/);
  rejects([{ type: 'since', items: [{ text: 'א', who: 'ac-ceo' }] }], /שדה לא מוכר "who"/);
  rejects([{ type: 'since', items: [{ task: 5 }] }], /רשימת משפטים/);
  rejects([{ type: 'note', text: 'x', icon: '🚀' }], /Material Symbol/);
  rejects(Array.from({ length: 13 }, () => ({ type: 'headline', text: 'x' })), /יותר מדי/);
});

test('since: a sentence may name its task, the default names it, so the line leads to who did it', async () => {
  const env = await homeEnv();
  try {
    const { hq } = env;
    const t = hq.scheduler.addTask({ title: 'תמונות', project: 'agent-company' });
    hq.store.db.prepare(`UPDATE tasks SET state = 'done', summary = ? WHERE id = ?`).run('התמונות עולות גם מהטלפון\nפרטים', t.id);
    const since = hq.home.current().blocks.find((b) => b.type === 'since');
    assert.deepEqual(since, { type: 'since', items: [{ text: 'התמונות עולות גם מהטלפון', task: t.id }] });
    hq.home.compose([{ type: 'since', items: [{ text: 'התמונות עולות', task: t.id }, 'הלילה עבר בשקט'] }], 'ac-ceo');
    assert.deepEqual(hq.home.current().blocks.find((b) => b.type === 'since'), { type: 'since', items: [{ text: 'התמונות עולות', task: t.id }, { text: 'הלילה עבר בשקט' }] });
    assert.throws(() => hq.home.compose([{ type: 'since', items: [{ text: 'א', task: t.id + 100 }] }], 'ac-ceo'), /אין משימה/);
  } finally { await env.cleanup(); }
});

test('fallback: the default with no recipe, the agent one while fresh, the default again when stale or invalid', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    const go = hq.inbox.add({ kind: 'go', title: 'GO: hq', from_identity: 'ac-ceo', blocking: true });
    let cur = hq.home.current();
    assert.equal(cur.source, 'hq', 'home-headline is on: hq writes the sentence');
    assert.equal(cur.fallback, 'none');
    assert.deepEqual(cur.blocks, [{ type: 'headline', text: 'בקשת אישור: hq.' }, { type: 'quiet', projects: ['agent-company'] }],
      'the active project that did not move folds into the last line; dormant lumo is not in it');
    // "מה לבדוק" is on the status screen: the default does not show it, a composed recipe still may.
    const t = hq.scheduler.addTask({ title: 'תמונות', project: 'agent-company' });
    hq.awaiting.mark(t.id, { awaiting: 'check', awaiting_note: 'לפתוח תמונה מהטלפון' }, 'ac-ceo');
    assert.equal(hq.home.current().blocks.some((b) => b.type === 'awaiting'), false);
    hq.home.compose([{ type: 'awaiting', tasks: [t.id] }], 'ac-ceo');
    hq.awaiting.clear(t.id, 'owner', 'checked');
    assert.deepEqual(hq.home.current().blocks.map((b) => b.type), ['headline', 'project'], 'a composed awaiting block is skipped: nothing left, the default shows');

    const r = hq.home.compose([{ type: 'headline', text: 'יום עמוס' }, { type: 'project', project: 'lumo' }], 'ac-ceo', 'בדיקה');
    cur = hq.home.current();
    assert.equal(cur.source, 'agent');
    assert.equal(cur.version, r.version);
    assert.equal(cur.composed_by, 'ac-ceo');
    // A GO nobody placed is not put into the home: it waits in the app's decisions tab.
    assert.deepEqual(cur.blocks.map((b) => b.type), ['headline', 'project']);

    clock.advance(STALE_MS + 1);
    cur = hq.home.current();
    assert.equal(cur.source, 'hq');
    assert.equal(cur.fallback, 'stale');
    assert.equal(cur.version, r.version);

    hq.home.compose([{ type: 'project', project: 'lumo' }], 'ac-ceo');
    // The project left the contract after composition: the stored recipe is no longer valid.
    hq.store.db.prepare(`UPDATE home_recipes SET blocks = ? WHERE version = (SELECT MAX(version) FROM home_recipes)`)
      .run(JSON.stringify([{ type: 'project', project: 'gone' }]));
    assert.equal(hq.home.current().fallback, 'invalid');

    hq.home.compose([{ type: 'headline', text: 'שקט' }], 'ac-ceo');
    assert.equal(hq.home.current().source, 'agent', 'composed by hand: it wins while fresh');
    hq.store.setToggle('ac-ceo/home-headline', false);
    assert.equal(hq.home.current().source, 'agent', 'the switch is hq\'s sentence, not the hand-composed recipe');
    clock.advance(STALE_MS + 1);
    assert.equal(hq.home.current().source, 'default', 'switched off: the plain default, the app writes the sentence');
  } finally { await env.cleanup(); }
});

test('the default is short: a sentence, what waits, a line per project that moved today, two things that finished', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    const old = hq.scheduler.addTask({ title: 'ישנה', project: 'lumo' });
    hq.store.db.prepare(`UPDATE tasks SET state = 'done', summary = 'מלפני יומיים' WHERE id = ?`).run(old.id);
    clock.advance(25 * 3_600_000);
    assert.deepEqual(hq.home.defaultRecipe().blocks, [{ type: 'headline', text: 'הכול שקט, ושום דבר לא מחכה לך.' }, { type: 'quiet', projects: ['agent-company'] }],
      'nothing moved in a day: no project line, nothing since, the project is quiet');
    hq.awaiting.mark(old.id, { awaiting: 'deploy', awaiting_note: 'לפרוס' }, 'ac-ceo');
    const done = ['הראשונה הסתיימה', 'השנייה הסתיימה\nפרטים', 'השלישית הסתיימה'].map((summary) => {
      const t = hq.scheduler.addTask({ title: summary, project: 'agent-company' });
      clock.advance(1000);
      hq.store.db.prepare(`UPDATE tasks SET state = 'done', summary = ?, updated_at = ? WHERE id = ?`).run(summary, hq.store.now(), t.id);
      return t.id;
    });
    hq.scheduler.addTask({ title: 'עוד לא', project: 'agent-company' });
    const run = hq.scheduler.addTask({ title: 'רצה בלומו', project: 'lumo' });
    hq.store.db.prepare(`UPDATE tasks SET state = 'running', identity = 'ac-ceo', started_at = ?, updated_at = ? WHERE id = ?`).run(hq.store.now(), hq.store.now(), run.id);
    const blocks = hq.home.defaultRecipe().blocks;
    assert.deepEqual(blocks.map((b) => b.type), ['headline', 'project', 'project', 'since'], 'no tasks, lanes or awaiting; every active project moved: no quiet line');
    assert.deepEqual(blocks[0], { type: 'headline', text: 'ביממה האחרונה הסתיימו 3 משימות. בינתיים אחת רצה בלומו, ושום דבר לא מחכה לך.' },
      '"מה לבדוק" is not a decision: nothing waits');
    assert.deepEqual(blocks[1], { type: 'project', project: 'lumo', note: 'רצה בלומו' }, 'nothing finished there: what runs');
    assert.deepEqual(blocks[2], { type: 'project', project: 'agent-company', note: 'השלישית הסתיימה' });
    assert.deepEqual(blocks[3], { type: 'since', items: [{ text: 'השלישית הסתיימה', task: done[2] }, { text: 'השנייה הסתיימה', task: done[1] }] });
  } finally { await env.cleanup(); }
});

test('sentence: a person\'s sentence from the facts, after the app\'s "N החלטות מחכות לך."', () => {
  const f = (o: Partial<HomeFacts>): HomeFacts => ({ waiting: 0, running: 0, where: [], done: 0, visited: true, stuck: 0, ...o });
  assert.equal(sentence(f({})), 'הכול שקט, ושום דבר לא מחכה לך.');
  assert.equal(sentence(f({ running: 2, where: ['לומו', 'החברה'] })), 'שתי משימות רצות בלומו ובחברה, ושום דבר לא מחכה לך.', 'בחברה, not בהחברה');
  assert.equal(sentence(f({ running: 1, where: ['tiki-bot-go'] })), 'משימה אחת רצה ב-tiki-bot-go, ושום דבר לא מחכה לך.');
  assert.equal(sentence(f({ running: 4, where: ['א', 'ב', 'ג'] })), '4 משימות רצות ב-3 פרויקטים, ושום דבר לא מחכה לך.');
  assert.equal(sentence(f({ done: 3 })), 'מאז שהיית פה הסתיימו 3 משימות. שום דבר לא מחכה לך.');
  assert.equal(sentence(f({ done: 1, visited: false })), 'ביממה האחרונה הסתיימה משימה אחת. שום דבר לא מחכה לך.');
  // With something waiting the app leads with the count: this names the one, and goes on.
  assert.equal(sentence(f({ waiting: 1, decision: { kind: 'go', text: 'בקשת אישור: שחרור voice-bot' }, running: 1, where: ['החברה'] })),
    'בקשת אישור: שחרור voice-bot. בינתיים משימה אחת רצה בחברה.');
  assert.equal(sentence(f({ waiting: 1, decision: { kind: 'ask', text: 'איזה שם לבוט?' } })), 'שאלה: איזה שם לבוט?');
  assert.equal(sentence(f({ waiting: 3, running: 2, done: 2 })), 'מאז שהיית פה הסתיימו שתי משימות. בינתיים שתיים רצות.');
  assert.equal(sentence(f({ waiting: 2 })), '', 'the lead says it all');
  // Many: what they are, and the GO by name when it is the only one.
  assert.equal(sentence(f({ waiting: 5, gos: 1, decision: { kind: 'go', text: 'בקשת אישור: שחרור voice-bot', first: true } })), 'בראש התור: שחרור voice-bot.', 'not two colons in a row');
  assert.equal(sentence(f({ waiting: 5, gos: 1, decision: { kind: 'go', text: 'בקשת אישור: שחרור voice-bot', first: false } })), 'אחת מהן היא בקשת אישור: שחרור voice-bot.');
  assert.equal(sentence(f({ waiting: 5, gos: 1, decision: { kind: 'go', text: 'א'.repeat(60), first: false }, done: 3, running: 2 })), 'אחת מהן היא בקשת אישור. בינתיים שתי משימות רצות.', 'a long name: without it');
  assert.equal(sentence(f({ done: 250, visited: false, running: 11, where: ['א', 'ב', 'ג', 'ד'] })),
    'ביממה האחרונה הסתיימו 250 משימות. בינתיים 11 רצות ב-4 פרויקטים, ושום דבר לא מחכה לך.', 'never a number right after a number');
  assert.equal(sentence(f({ waiting: 6, gos: 4, running: 2 })), '4 מהן בקשות אישור. בינתיים שתי משימות רצות.');
  assert.equal(sentence(f({ waiting: 2, gos: 2 })), 'שתיהן בקשות אישור.');
  assert.equal(sentence(f({ waiting: 3, gos: 3 })), 'כולן בקשות אישור.');
  assert.equal(sentence(f({ stuck: 2 })), 'שני עובדים תקועים. שום דבר לא מחכה לך.', 'never "הכול שקט" over a stuck worker');
  // Too long: the project names go first, then what finished, then the name of what waits.
  const long = sentence(f({ waiting: 1, decision: { kind: 'go', text: 'א'.repeat(55) }, running: 2, where: ['לומו', 'ב'.repeat(30)] }));
  assert.ok(long.length <= 100 && long.includes('א'.repeat(55)) && !long.includes('בלומו'), long);
  assert.equal(sentence(f({ waiting: 1, decision: { kind: 'go', text: 'א'.repeat(34) }, running: 1, done: 30 }), 70), `בקשת אישור: ${'א'.repeat(34)}. בינתיים משימה אחת רצה.`);
  assert.equal(sentence(f({ waiting: 1, decision: { kind: 'go', text: 'א'.repeat(80) }, running: 1, done: 30 }), 60), 'בינתיים משימה אחת רצה.');
});

test('"מאז שהיית פה": from the end of his visit before this one; opens close together are one visit', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    const finish = (title: string) => {
      const t = hq.scheduler.addTask({ title, project: 'agent-company' });
      hq.store.db.prepare(`UPDATE tasks SET state = 'done', summary = ?, updated_at = ? WHERE id = ?`).run(title, hq.store.now(), t.id);
    };
    finish('לפני הביקור');
    clock.advance(1000);
    hq.home.seen(true);
    assert.equal(hq.home.facts().visited, false, 'the first open: no visit before it');
    assert.equal(hq.home.facts().done, 1, 'the last day');
    clock.advance(VISIT_GAP_MS + 1);
    hq.home.seen(true);
    assert.equal(hq.home.facts().visited, true);
    assert.equal(hq.home.facts().done, 0, 'nothing finished since the visit before');
    finish('בזמן שהוא פה');
    clock.advance(60_000);
    hq.home.seen(true);
    assert.equal(hq.home.facts().done, 1, 'a minute later is the same visit: still counts from the one before');
    assert.match((hq.home.current().blocks[0] as { text: string }).text, /^מאז שהיית פה הסתיימה משימה אחת\./);
    // He stays: the reload once a minute keeps the visit going, so the next one counts from where he left.
    for (let i = 0; i < 30; i++) { clock.advance(60_000); hq.home.seen(false); }
    finish('לפני שהלך');
    clock.advance(VISIT_GAP_MS + 1);
    hq.home.seen(false);
    clock.advance(VISIT_GAP_MS + 1);
    hq.home.seen(true);
    assert.equal(hq.home.facts().done, 0, 'what finished while he sat there is not news; a reload after he left did not stretch the visit');
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
    assert.deepEqual(hq.home.current().blocks, [{ type: 'note', text: 'הערה', icon: 'info' }], 'decisions are not blocks of the home any more');
    assert.equal(hq.home.current().source, 'agent', 'pruning is not a reason to drop the recipe');
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

test('waiting_changed_at: when what waits for him last came in, was answered or was put off, so a headline composed before it is not shown', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    assert.equal(hq.home.current().waiting_changed_at, null, 'nothing ever waited');
    const go = hq.inbox.add({ kind: 'go', title: 'GO: hq', from_identity: 'ac-ceo', blocking: true });
    const added = clock.now();
    assert.equal(hq.home.current().waiting_changed_at, added);
    clock.advance(60_000);
    hq.home.compose([{ type: 'headline', text: 'GO קטן אחד מחכה לך' }], 'ac-ceo');
    assert.ok(hq.home.current().composed_at > hq.home.current().waiting_changed_at!, 'composed after it came in: the headline holds');
    clock.advance(60_000);
    hq.inbox.resolve(go.id);
    assert.equal(hq.home.current().waiting_changed_at, clock.now(), 'answered after the headline: it is stale');
    // Put off, then taken back: taking it back clears snoozed_at, and still counts.
    const b = hq.inbox.add({ kind: 'go', title: 'GO: app', from_identity: 'ac-ceo', blocking: true });
    clock.advance(60_000);
    hq.inbox.snooze(b.id, true);
    clock.advance(60_000);
    hq.inbox.snooze(b.id, false);
    assert.equal(hq.home.current().waiting_changed_at, clock.now(), 'taken back from "לא עכשיו"');
  } finally { await env.cleanup(); }
});

test('facts: as the app counts; the one GO among many is named when it is first in line, cut at a word', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    hq.inbox.add({ kind: 'go', title: 'GO: להעביר את כל הנהגים לגרסה שמתקנת את "ממתין להודעה", כולל הטווחים בדקות', from_identity: 'ac-ceo', blocking: true });
    clock.advance(1000);
    hq.inbox.add({ kind: 'ask', title: 'שאלה', from_identity: 'yoav' });
    let f = hq.home.facts();
    assert.equal(f.waiting, 2);
    assert.equal(f.gos, 1);
    assert.equal(f.decision!.text, 'GO: להעביר את כל הנהגים לגרסה שמתקנת את "ממתין להודעה", כולל…', 'at a word');
    assert.equal(sentence(f), 'בראש התור: להעביר את כל הנהגים לגרסה שמתקנת את "ממתין להודעה", כולל…');
    // A newer GO from the same worker replaces the old one (#258): the app does not count it, nor does this.
    clock.advance(1000);
    hq.inbox.add({ kind: 'go', title: 'GO: להעביר את כל הנהגים שלנו לגרסה החדשה שמתקנת את "ממתין להודעה" בכל הטווחים', from_identity: 'ac-ceo' });
    f = hq.home.facts();
    assert.equal(f.waiting, 2, 'the replaced GO is not counted');
    assert.equal(f.gos, 1);
    assert.equal(f.decision!.first, false, 'the question is first in line: the GO is not "בראש התור"');
    assert.equal(sentence(f), 'אחת מהן היא בקשת אישור: להעביר את כל הנהגים שלנו לגרסה החדשה שמתקנת את…');
    for (const i of hq.inbox.open()) if (!i.title.includes('החדשה')) hq.inbox.resolve(i.id);
    assert.equal(hq.home.facts().decision!.text, 'GO: להעביר את כל הנהגים שלנו לגרסה החדשה שמתקנת את…', 'a quote is not left open');
  } finally { await env.cleanup(); }
});

test('org.yaml of today, with compose-home only: hq does not write the sentence, עדי still may compose', async () => {
  const env = await makeEnv({ org: ORG.replace('{id: home-headline, what: hq כותב את המשפט בראש הבית, enabled: true}', '{id: compose-home, what: מרכיבה את הבית, enabled: false}'),
    projects: { 'agent-company': CHARTER('agent-company'), lumo: CHARTER('lumo', 'dormant') } });
  try {
    const { hq } = env;
    assert.equal(hq.home.enabled(), false);
    assert.equal(hq.home.composer(), 'ac-ceo');
    assert.equal(hq.home.current().source, 'default');
    assert.equal(hq.home.compose([{ type: 'headline', text: 'כותרת ביד' }], 'ac-ceo').source, 'agent');
    assert.equal(hq.home.current().source, 'agent');
  } finally { await env.cleanup(); }
});

test('quota: every account with both windows and their resets comes with the home, live; a duplicate is not one', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    const q0 = hq.home.current().quota!;
    assert.deepEqual(q0.map((q) => q.name), ['claude']);
    hq.store.db.prepare(`UPDATE accounts SET five_hour_pct = 17, seven_day_pct = 100, five_hour_resets_at = ?, seven_day_resets_at = ? WHERE name = 'claude'`)
      .run(clock.now() + 3600_000, clock.now() + 86_400_000);
    const [q] = hq.home.current().quota!;
    assert.equal(q!.five_hour_pct, 17);
    assert.equal(q!.seven_day_pct, 100);
    assert.equal(q!.full, true);
    assert.equal(q!.reopens_at, clock.now() + 86_400_000);
    assert.equal(q!.usable, true);
  } finally { await env.cleanup(); }
});

test('GET /api/home: only opened=1 or looking=1 from a device moves the visit; a reload on an event does not', async () => {
  const env = await homeEnv();
  try {
    const { hq, clock } = env;
    const [, , get] = buildRoutes(hq).find(([m, re]) => m === 'GET' && re.test('/api/home'))!;
    const call = (q: string) => get({ caller: { kind: 'device' }, url: new URL(`http://hq/api/home${q}`) } as never);
    const at = () => Number(hq.store.getMeta('home.visit_at') ?? 0);
    call('?opened=1');
    const opened = at();
    assert.equal(opened, clock.now());
    clock.advance(60_000);
    call('');
    assert.equal(at(), opened, 'the app open behind, reloading on an event: he is not there');
    call('?looking=1');
    assert.equal(at(), clock.now(), 'the minute\'s reload while in front: the visit goes on');
  } finally { await env.cleanup(); }
});
