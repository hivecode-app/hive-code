import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { pushWorthy } from '../src/inbox.ts';
import { buildRoutes } from '../src/api.ts';

test('blocking ask: owner first, pushed, escalated to יואב after 10 min, manager decision is a note', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.pusher.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } });
    const a = hq.mailbox.ask({ msg_id: 'ask-1', from: 'eli', question: 'לשלם את החשבון?', blocking: true, urgency: 'normal' });
    const item = hq.inbox.open()[0]!;
    assert.equal(item.kind, 'ask');
    assert.equal(item.from_identity, 'eli', 'comes from whoever asks, not relayed');
    await until(() => env.webPushes.length === 1, 2000, 'push');
    assert.equal(env.telegrams.length, 0);

    clock.advance(9 * 60_000);
    hq.scheduler.escalateAsks();
    assert.equal(hq.mailbox.getAsk(a.id)!.state, 'open');

    clock.advance(2 * 60_000);
    hq.scheduler.escalateAsks();
    assert.equal(hq.mailbox.getAsk(a.id)!.state, 'escalated');
    const esc = hq.mailbox.get('ask-1-escalation')!;
    assert.equal(esc.to_identity, 'yoav');
    assert.match(esc.body, /לשלם את החשבון/);
    assert.ok(hq.inbox.open().some((i) => i.kind === 'ask' && i.ref === 'ask-1'), 'still waits for him too');

    hq.mailbox.answer('ask-1', 'כן', 'manager', 'הסכום קטן מהסף שאישרת');
    const ans = hq.mailbox.get('ask-1-answer')!;
    assert.equal(ans.to_identity, 'eli');
    assert.equal(ans.priority, 'now');
    assert.match(ans.body, /יואב החליט במקום רן/);
    const open = hq.inbox.open();
    assert.ok(!open.some((i) => i.kind === 'ask'));
    const note = open.find((i) => i.kind === 'escalation_note')!;
    assert.ok(note);
    assert.equal(note.blocking, false);
    assert.equal(env.webPushes.length, 1, 'the note is not pushed');
  } finally { await env.cleanup(); }
});

test('non-blocking ask waits; at night a blocking ask escalates immediately; manager asks never escalate', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.ask({ msg_id: 'ask-nb', from: 'eli', question: 'איזה צבע?', blocking: false });
    clock.advance(60 * 60_000);
    hq.scheduler.escalateAsks();
    assert.equal(hq.mailbox.getAsk('ask-nb')!.state, 'open');

    hq.store.setToggle('night', true);
    hq.mailbox.ask({ msg_id: 'ask-n', from: 'eli', question: 'למזג?', blocking: true });
    hq.scheduler.escalateAsks();
    assert.equal(hq.mailbox.getAsk('ask-n')!.state, 'escalated');

    hq.mailbox.ask({ msg_id: 'ask-y', from: 'yoav', question: 'לפתוח פרויקט?', blocking: true });
    hq.scheduler.escalateAsks();
    assert.equal(hq.mailbox.getAsk('ask-y')!.state, 'open');
    assert.throws(() => hq.mailbox.answer('ask-y', 'כן', 'manager'), /only escalated/);
  } finally { await env.cleanup(); }
});

test('owner "done" on a tab handoff tells the requester now and closes the item (20/10 finding)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    const item = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ל-Cloudflare', blocking: true, ref: 'tab-77' });
    const { message } = hq.mailbox.complete(item.id, { note: 'נכנסתי' });
    assert.ok(message);
    assert.equal(message!.to_identity, 'eli');
    assert.equal(message!.priority, 'now');
    assert.equal(message!.ref, 'tab-77');
    assert.equal(hq.inbox.get(item.id)!.state, 'resolved');
    // It wakes the resting requester: a shift is requested and the message delivered.
    await until(() => hq.mailbox.get(message!.id)!.state === 'delivered', 3000, 'wake + deliver');
    assert.match(launcher.hosts.get('eli-1')!.sent[0]!.text, /רן סיים: כניסה ל-Cloudflare\nנכנסתי/);
    // Idempotent.
    assert.equal(hq.mailbox.complete(item.id).message, null);

    const ask = hq.mailbox.ask({ msg_id: 'ask-d', from: 'eli', question: 'GO?', blocking: true });
    const askItem = hq.inbox.open().find((i) => i.ref === ask.id)!;
    hq.mailbox.complete(askItem.id);
    assert.equal(hq.mailbox.getAsk('ask-d')!.state, 'answered');
    assert.equal(hq.mailbox.get('ask-d-answer')!.priority, 'now');
  } finally { await env.cleanup(); }
});

test('push only when blocked on him; focus lets only urgent incidents through; Telegram only when the app is not connected', async () => {
  assert.equal(pushWorthy({ kind: 'ask', blocking: true, urgency: 'normal' }, false), true);
  assert.equal(pushWorthy({ kind: 'ask', blocking: false, urgency: 'urgent' }, false), false);
  assert.equal(pushWorthy({ kind: 'delivery_failure', blocking: false, urgency: 'normal' }, false), false);
  assert.equal(pushWorthy({ kind: 'login', blocking: true, urgency: 'normal' }, false), true);
  assert.equal(pushWorthy({ kind: 'go', blocking: true, urgency: 'normal' }, true), false);
  assert.equal(pushWorthy({ kind: 'incident', blocking: true, urgency: 'urgent' }, true), true);

  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    // No device at all: the app is not connected, a GO goes to Telegram at once.
    hq.inbox.add({ kind: 'go', from_identity: 'ac-ceo', title: 'GO לפרודקשן', blocking: true });
    await until(() => env.telegrams.length === 1, 2000, 'telegram when offline');
    assert.match(env.telegrams[0]!, /GO לפרודקשן/);

    // The app connected, with a push subscription: pushed, and Telegram only for an urgent item he hasn't taken in
    // 5 minutes, or a GO / login in 15 (#204).
    hq.auth.link('phone', 1);
    hq.pusher.subscribe({ endpoint: 'https://push.example/2', keys: { p256dh: 'p', auth: 'a' } });
    const login = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'קוד ל-Mercury', blocking: true });
    const urgent = hq.inbox.add({ kind: 'ask', from_identity: 'rotem', title: 'prod למטה', blocking: true, urgency: 'urgent' });
    await until(() => env.webPushes.length === 2 && hq.inbox.get(urgent.id)!.pushed_at != null, 2000, 'pushes');
    clock.advance(4 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 1);
    clock.advance(2 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 2, 'urgent one only');
    assert.match(env.telegrams[1]!, /prod למטה/);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 2, 'once');
    clock.advance(10 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 3, 'the login after 15 minutes untaken');
    assert.match(env.telegrams[2]!, /קוד ל-Mercury[\s\S]*לא נענה תוך 15 דקות/);
    assert.ok(login.id);

    const acked = hq.inbox.add({ kind: 'ask', from_identity: 'rotem', title: 'שני', blocking: true, urgency: 'urgent' });
    await until(() => env.webPushes.length === 3, 2000, 'push 3');
    hq.inbox.ack(acked.id);
    clock.advance(20 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 3, 'acked items do not fall back');
  } finally { await env.cleanup(); }
});

test('inbox order: blocking first, then urgency, then age', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.store.setToggle('push', false);
    hq.inbox.add({ kind: 'delivery_failure', title: 'a', urgency: 'urgent' }); clock.advance(1);
    hq.inbox.add({ kind: 'ask', title: 'b', blocking: true, urgency: 'low' }); clock.advance(1);
    hq.inbox.add({ kind: 'ask', title: 'c', blocking: true, urgency: 'urgent' }); clock.advance(1);
    hq.inbox.add({ kind: 'ask', title: 'd', blocking: false, urgency: 'normal' });
    assert.deepEqual(hq.inbox.open().map((i) => i.title), ['c', 'b', 'a', 'd']);
  } finally { await env.cleanup(); }
});

test('a failed Telegram fallback is retried (up to 5), and stays visible', async () => {
  let fail = true;
  const sent: string[] = [];
  const env = await makeEnv({ deps: { telegram: async (t) => { if (fail) throw new Error('telegram down'); sent.push(t); } } });
  try {
    const { hq } = env;
    const it = hq.inbox.add({ kind: 'go', from_identity: 'ac-ceo', title: 'GO', blocking: true });
    await until(() => hq.store.db.prepare('SELECT telegram_failures n FROM inbox WHERE id = ?').pluck().get(it.id) === 1, 2000, 'first failure');
    assert.ok(hq.store.eventsAfter(0, 10_000).some((e) => e.type === 'push.telegram_failed'), 'visible');
    fail = false;
    await hq.pusher.sweepUnacked();
    assert.equal(sent.length, 1);
    await hq.pusher.sweepUnacked();
    assert.equal(sent.length, 1);
  } finally { await env.cleanup(); }
});

test('a written answer on an open item: a question is answered with it, a GO closes with his words', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    hq.mailbox.ask({ msg_id: 'ask-w', from: 'eli', headline: 'הבוטים', question: 'להעביר גם את הבוטים?', options: ['כן', 'לא'], blocking: true });
    const askItem = hq.inbox.open().find((i) => i.ref === 'ask-w')!;
    assert.equal(askItem.headline, 'הבוטים');
    const r1 = hq.mailbox.reply(askItem.id, 'לא, בלי הבוטים');
    assert.equal(hq.mailbox.getAsk('ask-w')!.answer, 'לא, בלי הבוטים');
    assert.equal(r1.item!.state, 'resolved');
    assert.match(r1.message!.body, /לא, בלי הבוטים/);

    const go = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: פריסה', headline: 'עדכון לאפליקציה: תמונות בצ\'אט', body: 'פריסה', blocking: true, ref: 'op-1' });
    const r2 = hq.mailbox.reply(go.id, 'כן, תפרוס עכשיו');
    assert.equal(hq.inbox.get(go.id)!.state, 'resolved');
    const m = r2.message!;
    assert.equal(m.to_identity, 'eli');
    assert.equal(m.priority, 'now');
    assert.equal(m.ref, 'op-1');
    assert.match(m.body, /עדכון לאפליקציה: תמונות בצ'אט/);
    assert.match(m.body, /תפרוס עכשיו/);
    assert.doesNotMatch(m.body, /סיים/);
    assert.throws(() => hq.mailbox.reply(go.id, 'שוב'), /already handled/, 'closed elsewhere: his words reach no one, so it fails');
    assert.throws(() => hq.mailbox.reply(askItem.id, 'שוב'), /already handled/);
    assert.throws(() => hq.mailbox.reply(9999, 'x'), /no inbox item/);
  } finally { await env.cleanup(); }
});

test('free text on a GO that is neither a yes nor a no does not close it: it is an ordinary message and the GO stays open (21/10)', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const go = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: פריסה', headline: 'קורא מסך', body: 'פריסה', blocking: true, ref: 'op-9' });
    const r = hq.mailbox.reply(go.id, 'תגיד אתה רציני מי בכלל צריך את זה?');
    assert.equal(hq.inbox.get(go.id)!.state, 'open', 'the GO waits for his decision');
    assert.equal(r.message!.to_identity, 'eli');
    assert.equal(r.message!.kind, 'tell');
    assert.match(r.message!.body, /עדיין פתוחה/);
    assert.match(r.message!.body, /רציני/);
    assert.equal(hq.mailbox.reply(go.id, 'לא').item!.state, 'resolved', 'a clear no closes it');
    const go2 = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: עוד', body: 'x', blocking: true, ref: 'op-10' });
    assert.equal(hq.mailbox.reply(go2.id, 'אשר').item!.state, 'resolved');
  } finally { await env.cleanup(); }
});

test('goVerdict: a yes is only approval words; a qualified yes, a question or "לא הבנתי" never closes a GO', async () => {
  const { goVerdict } = await import('../src/mailbox.ts');
  for (const t of ['אשר', 'כן', 'GO', 'בסדר, תפרוס עכשיו', 'yes', 'יאללה נתקן', 'יאללה, נתקן!', 'יאללה תריץ. מהר', 'כן תריץ']) assert.equal(goVerdict(t), 'yes', t);
  for (const t of ['בסדר אבל לא עכשיו', 'תפרוס רק אחרי 18:00', 'ok אבל מחר', 'תודה', 'עכשיו', 'זה', 'לא ממש הבנתי', 'לא כל כך ברור', 'no problem', 'no idea', 'כן, אבל רק אחרי 18:00', 'לא הבנתי מה הכוונה', 'למה?', 'תגיד אתה רציני מי צריך את זה', 'נתקן', 'תתקן', 'יאללה נתקן אחרי החג', 'יאללה נתקן? לא בטוח', 'יאללה נתקן רק את הראשון', 'תריץ', 'מהר', 'יאללה תריץ מחר']) {
    assert.equal(goVerdict(t), 'other', t);
  }
  for (const t of ['לא', 'לא, בלי הבוטים', 'דחה']) assert.equal(goVerdict(t), 'no', t);
});

test('a worker closing an inbox item is not "רן סיים" (#208)', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const withNote = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ל-Cloudflare', blocking: true, ref: 'tab-1' });
    const { message } = hq.mailbox.complete(withNote.id, { note: 'טופל כבר', by: 'noga' });
    assert.ok(message);
    assert.equal(message!.from_identity, 'noga');
    assert.equal(message!.to_identity, 'eli');
    assert.match(message!.body, /^noga סגר\/ה: כניסה ל-Cloudflare\nטופל כבר$/);
    assert.doesNotMatch(message!.body, /רן/);
    assert.equal(hq.inbox.get(withNote.id)!.state, 'resolved');

    // No words, nothing to say: the item closes and no message goes out.
    const bare = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ל-GitHub', blocking: true, ref: 'tab-2' });
    assert.equal(hq.mailbox.complete(bare.id, { by: 'adi' }).message, null);
    assert.equal(hq.inbox.get(bare.id)!.state, 'resolved');
    assert.equal(hq.mailbox.get(`inbox-${bare.id}-done`), undefined);

    // A question closed by someone else is not answered in his name.
    const ask = hq.mailbox.ask({ msg_id: 'ask-w', from: 'eli', question: 'GO?', blocking: true });
    const askItem = hq.inbox.open().find((i) => i.ref === ask.id)!;
    hq.mailbox.complete(askItem.id, { note: 'כן', by: 'adi' });
    assert.notEqual(hq.mailbox.getAsk('ask-w')!.state, 'answered');
    assert.equal(hq.mailbox.get('ask-w-answer'), undefined);
  } finally { await env.cleanup(); }
});

test('API: only a device token closes as the owner; the admin token closes in its own name (#208)', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const route = buildRoutes(hq).find(([m, re]) => m === 'POST' && re.test('/api/inbox/1/done'))!;
    const call = async (id: number, caller: any, b: Record<string, unknown>) =>
      (await route[2]({ req: null as any, url: new URL('http://x/'), params: [String(id)], body: async () => b, caller })) as any;
    const a = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה א', blocking: true, ref: 'login-a' });
    const b = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ב', blocking: true, ref: 'login-b' });
    const c = hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ג', blocking: true, ref: 'login-c' });
    const byDevice = await call(a.id, { kind: 'device' }, { note: 'סיימתי' });
    assert.equal(byDevice.message.from_identity, 'owner');
    assert.match(byDevice.message.body, /רן סיים: כניסה א\nסיימתי/);
    const byWorker = await call(b.id, { kind: 'admin' }, { note: 'עשיתי', from: 'noga' });
    assert.equal(byWorker.message.from_identity, 'noga');
    assert.doesNotMatch(byWorker.message.body, /רן/);
    const bare = await call(c.id, { kind: 'admin' }, {});
    assert.equal(bare.message, null);
    assert.equal(hq.inbox.get(c.id)!.state, 'resolved');
  } finally { await env.cleanup(); }
});

test('closeGo: approved_in_chat needs his real message after the card opened; withdrawn records no GO; only the asker or a manager closes (22/10)', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const open = (ref: string, from = 'eli') => hq.inbox.add({ kind: 'go', from_identity: from, title: 'GO: תיקון', headline: 'להחליט אם לתקן', blocking: true, ref, dedupe_key: `op:${ref}` });
    // Before the card: not evidence. A worker's message, or a no, is not either.
    hq.mailbox.tell({ msg_id: 'o-old', from: 'owner', to: 'eli', body: 'יאללה נתקן' });
    clock.advance(1000);
    const go = open('eli-1:10');
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'w-1', from: 'noa', to: 'eli', body: 'יאללה נתקן' });
    hq.mailbox.tell({ msg_id: 'o-no', from: 'owner', to: 'eli', body: 'לא, עזוב' });
    hq.mailbox.tell({ msg_id: 'o-ok', from: 'owner', to: 'eli', body: 'יאללה נתקן' });
    hq.mailbox.tell({ msg_id: 'o-hold', from: 'owner', to: 'eli', body: 'חכה' });
    hq.mailbox.tell({ msg_id: 'o-q', from: 'owner', to: 'eli', body: 'בסדר אבל לא עכשיו' });
    hq.mailbox.tell({ msg_id: 'o-other', from: 'owner', to: 'noa', body: 'יאללה נתקן' });
    hq.mailbox.tell({ msg_id: 'o-sys', from: 'owner', to: 'eli', kind: 'answer', body: 'רן סיים: משהו אחר' });
    const close = (ref: string, outcome: 'approved_in_chat' | 'withdrawn', by: string, message?: string) => {
      try { return hq.mailbox.closeGo(ref, outcome, by, message); } catch (e) { return (e as { status: number }).status; }
    };
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli'), 400, 'no message');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'nope'), 400, 'unknown message');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'w-1'), 400, 'not from him');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'o-old'), 400, 'written before the card');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'o-no'), 409, 'reads as a no');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'o-hold'), 409, 'not a clear yes');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'o-q'), 409, 'a qualified yes');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'o-other'), 400, 'written to another worker');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'eli', 'o-sys'), 400, 'hq\'s own message in his name');
    assert.equal(close('eli-1:10', 'approved_in_chat', 'noa', 'o-ok'), 403, 'not the asker');
    assert.equal(hq.inbox.get(go.id)!.state, 'open');
    const r = hq.mailbox.closeGo('eli-1:10', 'approved_in_chat', 'eli', 'o-ok') as { item: { state: string; body: string }; quote: string };
    assert.equal(r.item.state, 'resolved');
    assert.equal(r.quote, 'יאללה נתקן');
    assert.match(r.item.body, /אושר בשיחה: «יאללה נתקן»/);
    const ev = hq.store.db.prepare(`SELECT data FROM events WHERE type = 'inbox.completed' ORDER BY seq DESC LIMIT 1`).get() as { data: string };
    assert.deepEqual({ how: JSON.parse(ev.data).how, by: JSON.parse(ev.data).by, message: JSON.parse(ev.data).message }, { how: 'chat', by: 'eli', message: 'o-ok' }, 'never recorded as his own click');
    assert.equal((hq.mailbox.closeGo('eli-1:10', 'withdrawn', 'eli') as { already: boolean }).already, true, 'closed twice: nothing changes');

    // Withdrawn: dismissed, by the asker's manager too, found by inbox-<id>.
    const g2 = open('eli-1:11');
    const w = hq.mailbox.closeGo(`inbox-${g2.id}`, 'withdrawn', 'yoav');
    assert.equal(w.item.state, 'dismissed');
    assert.equal(w.quote, null);

    // His note on a GO card (hq wraps it) counts by his words; a manager closing it tells the asker.
    const g3 = open('eli-1:12');
    clock.advance(1000);
    hq.mailbox.reply(g3.id, 'יאללה נתקן אחרי החג');
    const wrapped = (hq.store.db.prepare(`SELECT id FROM messages WHERE id LIKE 'inbox-${g3.id}-note-%'`).get() as { id: string }).id;
    assert.equal(close('eli-1:12', 'approved_in_chat', 'yoav', wrapped), 409, 'wrapper stripped, still not a yes');
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'o-yoav', from: 'owner', to: 'yoav', body: 'יאללה נתקן' });
    assert.equal(hq.mailbox.closeGo('eli-1:12', 'approved_in_chat', 'yoav', 'o-yoav').item.state, 'resolved', 'the manager closes with his message to the manager');
    assert.match(hq.mailbox.get(`inbox-${g3.id}-closed-by-yoav`)!.body, /אושרה בשיחה/);

    // A request_access card is closed only by his own decision.
    const acc = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: kubectl', blocking: true, ref: 'acc-7' });
    assert.equal(close('acc-7', 'withdrawn', 'eli'), 409);
    assert.equal(hq.inbox.get(acc.id)!.state, 'open');
    assert.equal(close('missing', 'withdrawn', 'eli'), 404);
  } finally { await env.cleanup(); }
});

test('#297: his yes in the chat closes the worker\'s one open GO; with a ref it is his answer on that card; never an access card', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const go = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: צי ההסעות', headline: 'להחליט אם לסדר את צי ההסעות', blocking: true, ref: 'eli-1:go' });
    // Not a clear yes, and no ref: an ordinary message, the card stays open.
    let m = hq.mailbox.tell({ msg_id: 'c-1', from: 'owner', to: 'eli', body: 'לא במוצאי שבת, אעדכן אותך', chat: true });
    assert.equal(m.id, 'c-1');
    assert.equal(hq.inbox.get(go.id)!.state, 'open');
    // Another worker's conversation: not this card.
    hq.mailbox.tell({ msg_id: 'c-2', from: 'owner', to: 'noa', body: 'יאללה', chat: true });
    assert.equal(hq.inbox.get(go.id)!.state, 'open');
    // 25/10: "יאללה תריץ. מהר" in eli's conversation is the GO.
    m = hq.mailbox.tell({ msg_id: 'c-3', from: 'owner', to: 'eli', body: 'יאללה תריץ. מהר', chat: true });
    assert.equal(hq.inbox.get(go.id)!.state, 'resolved');
    assert.equal(m.to_identity, 'eli');
    assert.equal(m.kind, 'answer');
    assert.match(m.body, /יאללה תריץ/);
    const done = env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'inbox.completed').at(-1)!;
    assert.equal((done.data as any).id, go.id);
    assert.equal((done.data as any).declined, false);

    // Two open: a bare yes without a ref is not taken for either.
    const a = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: א', blocking: true, ref: 'eli-1:a' });
    const b = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: ב', blocking: true, ref: 'eli-1:b' });
    hq.mailbox.tell({ msg_id: 'c-4', from: 'owner', to: 'eli', body: 'כן', chat: true });
    assert.deepEqual([a, b].map((x) => hq.inbox.get(x.id)!.state), ['open', 'open']);
    // With a ref: his answer on that card. A question keeps it open, a no closes it.
    m = hq.mailbox.tell({ msg_id: 'c-5', from: 'owner', to: 'eli', ref: 'eli-1:b', body: 'למה?', chat: true });
    assert.equal(hq.inbox.get(b.id)!.state, 'open');
    assert.match(m.body, /עדיין פתוחה/);
    hq.mailbox.tell({ msg_id: 'c-6', from: 'owner', to: 'eli', ref: `inbox-${b.id}`, body: 'לא', chat: true });
    assert.equal(hq.inbox.get(b.id)!.state, 'resolved');
    assert.equal(hq.inbox.get(a.id)!.state, 'open');

    // Two questions of eli's open: a bare "כן" may answer either, so it is not taken for the GO.
    hq.inbox.resolve(b.id);
    hq.mailbox.ask({ msg_id: 'ask-q1', from: 'eli', question: 'א?', blocking: true });
    hq.mailbox.ask({ msg_id: 'ask-q2', from: 'eli', question: 'ב?', blocking: true });
    m = hq.mailbox.tell({ msg_id: 'c-8', from: 'owner', to: 'eli', body: 'כן', chat: true });
    assert.equal(m.id, 'c-8');
    assert.equal(hq.inbox.get(a.id)!.state, 'open');
    hq.mailbox.withdraw('ask-q1');
    hq.mailbox.withdraw('ask-q2');

    // An access card is decided only on the card.
    hq.inbox.resolve(a.id);
    const acc = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'גישה', blocking: true, ref: 'acc-7' });
    m = hq.mailbox.tell({ msg_id: 'c-7', from: 'owner', to: 'eli', body: 'כן', chat: true });
    assert.equal(m.id, 'c-7');
    assert.equal(hq.inbox.get(acc.id)!.state, 'open');
  } finally { await env.cleanup(); }
});
