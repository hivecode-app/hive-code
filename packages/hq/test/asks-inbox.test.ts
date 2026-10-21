import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { pushWorthy } from '../src/inbox.ts';

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
  for (const t of ['אשר', 'כן', 'GO', 'בסדר, תפרוס עכשיו', 'yes']) assert.equal(goVerdict(t), 'yes', t);
  for (const t of ['בסדר אבל לא עכשיו', 'תפרוס רק אחרי 18:00', 'ok אבל מחר', 'תודה', 'עכשיו', 'זה', 'לא ממש הבנתי', 'לא כל כך ברור', 'no problem', 'no idea', 'כן, אבל רק אחרי 18:00', 'לא הבנתי מה הכוונה', 'למה?', 'תגיד אתה רציני מי צריך את זה']) {
    assert.equal(goVerdict(t), 'other', t);
  }
  for (const t of ['לא', 'לא, בלי הבוטים', 'דחה']) assert.equal(goVerdict(t), 'no', t);
});
