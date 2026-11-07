// The conversation model with the owner (docs/app/chat.md §2.3א): in a turn he started, the worker's text is the reply
// (one bubble, not a `tell` on top of it), and a `tell` to him in that turn never replaces it (08/11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until, type TestEnv } from './helpers.ts';

async function ownerTurn(env: TestEnv, id: string, body: string) {
  const { hq, launcher } = env;
  hq.mailbox.tell({ msg_id: id, to: 'eli', body });
  await until(() => hq.mailbox.get(id)!.state === 'delivered', 3000, 'delivered');
  const host = launcher.hosts.get('eli-1')!;
  host.deliveryState(id, 'started');
  await until(() => hq.mailbox.get(id)!.state === 'seen', 3000, 'seen');
  return host;
}

const toOwner = (env: TestEnv) => env.hq.mailbox.list('owner').filter((m) => m.from_identity === 'eli' && m.to_identity === 'owner');

test('owner-triggered turn: the final assistant text becomes exactly one stored reply (ref + text_ref), his message handled', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-hi', 'היי');
    host.event({ kind: 'text', text: 'רגע, בודק', messageId: 'msg_a' });
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'gh pr list' } });
    host.event({ kind: 'tool_result', toolUseId: 't1', isError: false, preview: '' });
    host.event({ kind: 'text', text: 'היי רן. PR #17 מוזג. לפתוח צוות ל-CI?', messageId: 'msg_b' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'היי רן. PR #17 מוזג. לפתוח צוות ל-CI?' });
    await until(() => toOwner(env).length === 1, 3000, 'reply stored');
    const [r] = toOwner(env);
    assert.equal(r!.id, 'm-hi-reply');
    assert.equal(r!.ref, 'm-hi');
    assert.equal(r!.text_ref, 'msg_b', 'the app merges the streamed bubble and this message by text_ref');
    assert.equal(r!.body, 'רגע, בודק\n\nהיי רן. PR #17 מוזג. לפתוח צוות ל-CI?', 'every text block of the turn, in order');
    assert.equal(env.hq.mailbox.get('m-hi')!.state, 'handled');
    assert.ok(env.hq.store.eventsAfter(0, 5000).some((e) => e.type === 'message.new' && (e.data as { id: string }).id === 'm-hi-reply'),
      'message.new → conversation list, inbox badge, notifications');

    // A replay of the same result (hq restart) does not store a second reply.
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'היי רן. PR #17 מוזג. לפתוח צוות ל-CI?' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(toOwner(env).length, 1);
  } finally { await env.cleanup(); }
});

test('08/11 adi: a tell to him in his turn is a separate message; the text written after it is still the stored reply', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-1794073849539-0', 'אני סוגר את האפליקציה תשלח את ההתראה ואז תגיד לי מה הוא נשאר פתוח לפני שמעלים בהשקה');
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__tell', input: { to: 'owner', urgency: 'now', body: 'הודעת בדיקה' } });
    env.hq.mailbox.tell({ msg_id: 'adi-12:mw6p91bn-026bffb8d7', from: 'eli', to: 'owner', body: 'הודעת בדיקה' }); // no ref, as in the DB
    host.event({ kind: 'tool_result', toolUseId: 't1', isError: false, preview: '{"queued":true}' });
    host.event({ kind: 'tool_use', toolUseId: 't2', name: 'Bash', input: { command: 'journalctl …' } });
    host.event({ kind: 'tool_result', toolUseId: 't2', isError: false, preview: '' });
    const text = 'שלחתי לך הודעת בדיקה.\n\n**מה נשאר לפני ההשקה:** …';
    host.event({ kind: 'text', text, messageId: 'msg_launch' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text });
    await until(() => toOwner(env).length === 2, 3000, 'reply stored next to the tell');
    const r = env.hq.mailbox.get('m-1794073849539-0-reply')!;
    assert.equal(r.body, text);
    assert.equal(r.ref, 'm-1794073849539-0');
    assert.equal(r.text_ref, 'msg_launch');
    assert.equal(env.hq.mailbox.get('adi-12:mw6p91bn-026bffb8d7')!.body, 'הודעת בדיקה', 'the tell stays as it was');
    assert.equal(env.hq.mailbox.get('m-1794073849539-0')!.state, 'handled');
  } finally { await env.cleanup(); }
});

test('a tell stored with no tool call (the API from Bash) does not suppress the turn\'s text either', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-hi2', 'היי');
    env.hq.mailbox.tell({ msg_id: 'eli-1:tell', from: 'eli', to: 'owner', body: 'היי רן. לפתוח צוות?' });
    assert.equal(env.hq.mailbox.get('m-hi2')!.state, 'seen');
    host.event({ kind: 'text', text: 'PR #17 מוזג.', messageId: 'msg_c' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'PR #17 מוזג.' });
    await until(() => toOwner(env).length === 2, 3000, 'reply stored');
    assert.deepEqual(toOwner(env).map((m) => m.id).sort(), ['eli-1:tell', 'm-hi2-reply']);
    assert.equal(env.hq.mailbox.get('m-hi2')!.state, 'handled');
  } finally { await env.cleanup(); }
});

test('a tell to him with ref (his message handled on the spot) still leaves the text as the reply; another result stores no second', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-r', 'מה נשאר?');
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__tell', input: { to: 'owner', ref: 'm-r', body: 'בדיקה' } });
    env.hq.mailbox.tell({ msg_id: 'eli-1:t', from: 'eli', to: 'owner', body: 'בדיקה', ref: 'm-r' });
    assert.equal(env.hq.mailbox.get('m-r')!.state, 'handled');
    host.event({ kind: 'text', text: 'הנה מה שנשאר: X', messageId: 'msg_r' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'הנה מה שנשאר: X' });
    await until(() => !!env.hq.mailbox.get('m-r-reply'), 3000, 'reply stored');
    assert.equal(env.hq.mailbox.get('m-r-reply')!.body, 'הנה מה שנשאר: X');
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'הנה מה שנשאר: X' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(toOwner(env).map((m) => m.id).sort(), ['eli-1:t', 'm-r-reply']);
  } finally { await env.cleanup(); }
});

test('a tell to a name instead of an id ("רן") is rejected; the turn\'s text is still his reply', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-n', 'היי');
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__tell', input: { to: 'רן', body: 'היי' } });
    host.event({ kind: 'text', text: 'היי רן.', messageId: 'msg_n' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'היי רן.' });
    await until(() => toOwner(env).length === 1, 3000, 'reply stored');
    assert.equal(toOwner(env)[0]!.id, 'm-n-reply');
  } finally { await env.cleanup(); }
});

test('text, then tools (request_go among them), then a round with no text: the text he saw is the stored reply', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-long', 'מה המצב?');
    host.event({ kind: 'text', text: 'התשובה הארוכה על 4% ועצירות.', messageId: 'msg_l1' });
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__open_team', input: {} });
    host.event({ kind: 'text', text: 'Good — deploying.', messageId: 'msg_l2' });
    host.event({ kind: 'tool_use', toolUseId: 't2', name: 'mcp__company__request_go', input: {} });
    host.event({ kind: 'text', text: 'ביקשתי GO.', messageId: 'msg_l3' });
    host.event({ kind: 'tool_use', toolUseId: 't3', name: 'mcp__company__remember', input: {} });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    await until(() => toOwner(env).length === 1, 3000, 'reply stored');
    const [r] = toOwner(env);
    assert.equal(r!.body, 'התשובה הארוכה על 4% ועצירות.\n\nGood — deploying.', 'text before the owner-facing call; the narration after it is not stored');
    assert.equal(r!.text_ref, 'msg_l2');
    assert.equal(env.hq.mailbox.get('m-long')!.state, 'handled');
  } finally { await env.cleanup(); }
});

test('ask seen only as a tool call (op not yet ingested) still suppresses the text reply', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-q', 'מה המצב?');
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__ask', input: { question: 'למזג?', options: ['כן', 'לא'] } });
    host.event({ kind: 'text', text: 'שאלתי את רן.', messageId: 'msg_d' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'שאלתי את רן.' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(toOwner(env).length, 0);
  } finally { await env.cleanup(); }
});

test('his message left from an errored turn does not make a later, unrelated turn a reply', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const host = await ownerTurn(env, 'm-err', 'היי');
    host.event({ kind: 'result', subtype: 'error_during_execution', isError: true });
    await until(() => hq.shifts.get('eli-1')!.in_turn === 0, 3000, 'turn over');
    assert.equal(hq.mailbox.get('m-err')!.state, 'seen', 'not answered, not hidden');
    hq.mailbox.tell({ msg_id: 'r-2', from: 'rotem', to: 'eli', body: 'תבדוק' });
    await until(() => hq.mailbox.get('r-2')!.state === 'delivered');
    host.deliveryState('r-2', 'started');
    await until(() => hq.mailbox.get('r-2')!.state === 'seen');
    host.event({ kind: 'text', text: 'קיבלתי מרותם, בודק לבד.', messageId: 'msg_r' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'קיבלתי מרותם, בודק לבד.' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(toOwner(env).length, 0, 'internal text of a turn rotem started is not a reply to him');
  } finally { await env.cleanup(); }
});

test('lumo-t552 25/10: the text of a turn he did not start, that he saw stream in, stays in his conversation as a quiet note', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'r-1', from: 'rotem', to: 'eli', body: 'תבדוק' });
    await until(() => hq.mailbox.get('r-1')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('r-1', 'started');
    await until(() => hq.mailbox.get('r-1')!.state === 'seen');
    host.event({ kind: 'text', text: 'הנה הודעת הפרומו:', messageId: 'msg_e' });
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' } });
    host.event({ kind: 'tool_result', toolUseId: 't1', isError: false, preview: '' });
    host.event({ kind: 'text', text: 'כשענבל תאשר, אעדכן אותך.', messageId: 'msg_f' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'כשענבל תאשר, אעדכן אותך.' });
    const notes = () => hq.mailbox.list('eli').filter((m) => m.kind === 'note');
    await until(() => notes().length === 1, 3000, 'note stored');
    const [n] = notes();
    assert.equal(n!.to_identity, 'owner');
    assert.equal(n!.body, 'כשענבל תאשר, אעדכן אותך.', 'the final text only, not what came before the tools');
    assert.equal(n!.id, 'eli-note-msg_f', 'keyed by the block, the same however the log is replayed');
    assert.equal(n!.text_ref, 'msg_f', 'the app shows it once, over the streamed bubble');
    assert.equal(n!.state, 'handled');
    assert.equal(toOwner(env).length, 0, 'not a line in his conversation list');
    assert.equal(hq.conversations.get('eli').unread, 0, 'not unread');
    assert.ok(!hq.store.eventsAfter(0, 5000).some((e) => e.type === 'conv.alert'), 'no alert');
    // A replay of the same result (hq restart) keeps one.
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'כשענבל תאשר, אעדכן אותך.' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notes().length, 1);
  } finally { await env.cleanup(); }
});

test('no note for a turn that only wrote "בודק" before its tools, or that reached him itself (a message stored to him)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    const turn = async (id: string) => {
      hq.mailbox.tell({ msg_id: id, from: 'rotem', to: 'eli', body: 'תבדוק' });
      await until(() => hq.mailbox.get(id)!.state === 'delivered');
      const host = launcher.hosts.get('eli-1')!;
      host.deliveryState(id, 'started');
      await until(() => hq.mailbox.get(id)!.state === 'seen');
      return host;
    };
    let host = await turn('r-4');
    host.event({ kind: 'text', text: 'בודק', messageId: 'msg_h' });
    host.event({ kind: 'tool_use', toolUseId: 't2', name: 'Bash', input: { command: 'ls' } });
    host.event({ kind: 'tool_result', toolUseId: 't2', isError: false, preview: '' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    await until(() => hq.shifts.get('eli-1')!.in_turn === 0, 3000, 'turn over');
    host = await turn('r-5');
    hq.mailbox.tell({ msg_id: 'eli-api', from: 'eli', to: 'owner', body: 'הפרומו יצא.' }); // the API from Bash: no tool call to see
    host.event({ kind: 'text', text: 'שלחתי לרן שהפרומו יצא.', messageId: 'msg_i' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'שלחתי לרן שהפרומו יצא.' });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(hq.mailbox.list('eli').filter((m) => m.kind === 'note').map((m) => m.body), []);
  } finally { await env.cleanup(); }
});

test('a note is the worker\'s own final text: a subagent\'s report after its Agent call is not in it', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'r-6', from: 'rotem', to: 'eli', body: 'תבדוק' });
    await until(() => hq.mailbox.get('r-6')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('r-6', 'started');
    await until(() => hq.mailbox.get('r-6')!.state === 'seen');
    host.event({ kind: 'tool_use', toolUseId: 'a1', name: 'Agent', input: { prompt: 'x' } });
    host.event({ kind: 'text', text: '## דוח ארוך של הסוכן', messageId: 'msg_sub', parentToolUseId: 'a1' });
    host.event({ kind: 'tool_result', toolUseId: 'a1', isError: false, preview: '' });
    host.event({ kind: 'text', text: 'הסוכן סיים, הכול תקין.', messageId: 'msg_top' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'הסוכן סיים, הכול תקין.' });
    await until(() => hq.mailbox.list('eli').some((m) => m.kind === 'note'), 3000, 'note stored');
    assert.deepEqual(hq.mailbox.list('eli').filter((m) => m.kind === 'note').map((m) => m.body), ['הסוכן סיים, הכול תקין.']);
  } finally { await env.cleanup(); }
});

test('his message mid-turn: the text before it is a note, unless the turn already sent him a message', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'r-7', from: 'rotem', to: 'eli', body: 'תבדוק' });
    await until(() => hq.mailbox.get('r-7')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('r-7', 'started');
    await until(() => hq.mailbox.get('r-7')!.state === 'seen');
    host.event({ kind: 'text', text: 'רותם, בדקתי: תקין.', messageId: 'msg_pre' });
    hq.mailbox.tell({ msg_id: 'm-mid', to: 'eli', body: 'מה קורה?' });
    await until(() => hq.mailbox.get('m-mid')!.state === 'delivered');
    host.deliveryState('m-mid', 'started');
    await until(() => hq.mailbox.get('m-mid')!.state === 'seen');
    host.event({ kind: 'text', text: 'הכול תקין אצלי.', messageId: 'msg_ans' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'הכול תקין אצלי.' });
    await until(() => hq.mailbox.get('m-mid-reply') != null, 3000, 'reply stored');
    assert.equal(hq.mailbox.get('m-mid-reply')!.body, 'הכול תקין אצלי.');
    assert.deepEqual(hq.mailbox.list('eli').filter((m) => m.kind === 'note').map((m) => m.body), ['רותם, בדקתי: תקין.']);
  } finally { await env.cleanup(); }
});

test('a note answers nothing: his message waiting from an errored turn stays unanswered', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const host = await ownerTurn(env, 'm-wait', 'היי');
    host.event({ kind: 'result', subtype: 'error_during_execution', isError: true });
    await until(() => hq.shifts.get('eli-1')!.in_turn === 0, 3000, 'turn over');
    hq.mailbox.tell({ msg_id: 'r-3', from: 'rotem', to: 'eli', body: 'תבדוק' });
    await until(() => hq.mailbox.get('r-3')!.state === 'delivered');
    host.deliveryState('r-3', 'started');
    await until(() => hq.mailbox.get('r-3')!.state === 'seen');
    host.event({ kind: 'text', text: 'בודק לרותם.', messageId: 'msg_g' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'בודק לרותם.' });
    await until(() => hq.mailbox.list('eli').some((m) => m.kind === 'note'), 3000, 'note stored');
    assert.deepEqual(hq.mailbox.unanswered('eli').map((m) => m.id), ['m-wait']);
  } finally { await env.cleanup(); }
});

test('board: a live idle shift is "free" (פנוי), never "resting" (נח); no shift is resting', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-s', 'היי');
    host.event({ kind: 'text', text: 'היי', messageId: 'msg_f' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'היי' });
    await until(() => env.hq.shifts.get('eli-1')!.in_turn === 0, 3000, 'turn over');
    const b = env.hq.board();
    const eli = b.find((x) => x.id === 'eli')!;
    assert.equal(eli.live, true);
    assert.equal(eli.status, 'free');
    assert.equal(eli.status_symbol, 'radio_button_unchecked');
    const amit = b.find((x) => x.id === 'amit')!;
    assert.equal(amit.live, false);
    assert.equal(amit.status, 'resting');
  } finally { await env.cleanup(); }
});

test('reply times: from his message to the first streamed word after it was read, and to the reply, per worker', async () => {
  const { replyTimes, replyTimesByWorker } = await import('../src/reply-times.ts');
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const sent = clock.now();
    const host = await ownerTurn(env, 'm-time', 'תפצל לי להודעות שאפשר להעתיק');
    clock.advance(4000);
    host.live({ t: 'delta', ev: { kind: 'text_delta', text: 'הנה' } });
    await until(() => hq.mailbox.get('m-time')!.first_word_at != null, 3000, 'first word');
    clock.advance(3000);
    host.live({ t: 'delta', ev: { kind: 'text_delta', text: ' הכול' } });
    host.event({ kind: 'text', text: 'הנה הכול', messageId: 'msg_t' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'הנה הכול' });
    await until(() => hq.mailbox.get('m-time')!.state === 'handled', 3000, 'handled');
    const [t] = replyTimes(hq.store, sent - 1);
    assert.equal(t!.first_word_ms, 4000, 'the first word, not the last');
    assert.equal(t!.reply_ms, 7000);

    // A message he sent that was answered by a tool alone: its first word is the reply.
    const host2 = await ownerTurn(env, 'm-tool', 'שלח לי ב-tell');
    clock.advance(2000);
    hq.mailbox.tell({ msg_id: 'eli-1:t2', from: 'eli', to: 'owner', body: 'שלחתי', ref: 'm-tool' });
    host2.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    await until(() => hq.mailbox.get('m-tool')!.state === 'handled', 3000, 'handled by the tell');
    const w = replyTimesByWorker(replyTimes(hq.store, sent - 1));
    assert.equal(w.length, 1);
    assert.equal(w[0]!.identity, 'eli');
    assert.equal(w[0]!.messages, 2);
    assert.equal(w[0]!.answered, 2);
    assert.ok(w[0]!.first_word_p50_ms != null && w[0]!.reply_p90_ms === 7000);
  } finally { await env.cleanup(); }
});

test('reply times: two messages read together share the first word; one left unanswered gets no word of a later turn', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const host = await ownerTurn(env, 'm-thanks', 'תודה');
    host.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    await until(() => hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'engine.result'`).get() != null, 3000, 'turn ended');
    await new Promise((r) => setTimeout(r, 30));
    clock.advance(60_000);
    await ownerTurn(env, 'm-a', 'תפצל');
    await ownerTurn(env, 'm-b', 'ותוסיף את הקישור');
    clock.advance(2000);
    host.live({ t: 'delta', ev: { kind: 'text_delta', text: 'הנה' } });
    await until(() => hq.mailbox.get('m-b')!.first_word_at != null, 3000, 'first word');
    assert.equal(hq.mailbox.get('m-a')!.first_word_at, hq.mailbox.get('m-b')!.first_word_at);
    assert.equal(hq.mailbox.get('m-thanks')!.first_word_at, null, 'read in an earlier turn');
  } finally { await env.cleanup(); }
});
