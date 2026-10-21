// The conversation model with the owner (docs/app/chat.md §2.3א), reproducing the 20/10 bug: after "היי" the
// app showed two bubbles from yoav — a `tell` and the turn's own text ("ענית לרן…") — and the header said "נח".
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

test('owner-triggered turn that answered with tell(owner): the tell is the reply, the self-narration is not stored', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-hi2', 'היי');
    // No tool_use and no ref on purpose (e.g. the API from Bash): the stored tell alone suppresses the text.
    env.hq.mailbox.tell({ msg_id: 'eli-1:tell', from: 'eli', to: 'owner', body: 'היי רן. לפתוח צוות?' });
    assert.equal(env.hq.mailbox.get('m-hi2')!.state, 'seen');
    host.event({ kind: 'text', text: 'ענית לרן ושאלת אם לפתוח צוות. ההודעה נכנסה לתור המסירה.', messageId: 'msg_c' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'ענית לרן ושאלת אם לפתוח צוות. ההודעה נכנסה לתור המסירה.' });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(toOwner(env).map((m) => m.id), ['eli-1:tell'], 'one owner-visible message, not two');
    assert.equal(env.hq.mailbox.get('m-hi2')!.state, 'handled');
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

test('a tell to a name instead of an id ("רן") was meant for him: no text reply on top of the resend', async () => {
  const env = await makeEnv();
  try {
    const host = await ownerTurn(env, 'm-n', 'היי');
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__tell', input: { to: 'רן', body: 'היי' } });
    host.event({ kind: 'text', text: 'שלחתי לרן.', messageId: 'msg_n' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'שלחתי לרן.' });
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

test('a turn nobody from the owner started stores nothing for him', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'r-1', from: 'rotem', to: 'eli', body: 'תבדוק' });
    await until(() => hq.mailbox.get('r-1')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('r-1', 'started');
    await until(() => hq.mailbox.get('r-1')!.state === 'seen');
    host.event({ kind: 'text', text: 'בדקתי', messageId: 'msg_e' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'בדקתי' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(toOwner(env).length, 0);
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
