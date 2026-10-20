import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, until } from './helpers.ts';
import { sniffImage } from '../src/uploads.ts';

// A 1x1 PNG: the smallest real image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function apiEnv() {
  const env = await makeEnv({ noStart: true });
  await env.hq.start({ listen: true, timers: false });
  const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
  const base = `http://127.0.0.1:${env.hq.port}`;
  const auth = { authorization: `Bearer ${token}` };
  const upload = async (data: Buffer, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { ...auth, 'content-type': 'image/png', ...headers }, body: new Uint8Array(data) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const tell = async (body: unknown) => {
    const res = await fetch(`${base}/api/messages/tell`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...env, base, auth, upload, tell };
}

test('sniffImage: decided by the bytes, never by the header', () => {
  assert.equal(sniffImage(PNG)?.mime, 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.mime, 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......'))?.mime, 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime, 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('an attached image: uploaded, stored owner-only, sent as a path the worker opens with Read', async () => {
  const env = await apiEnv();
  try {
    assert.equal((await fetch(`${env.base}/api/uploads`, { method: 'POST', body: new Uint8Array(PNG) })).status, 401, 'token required');
    assert.equal((await env.upload(Buffer.from('not an image'))).status, 415);
    assert.equal((await env.upload(Buffer.alloc(0))).status, 400);

    const up = await env.upload(PNG, { 'x-file-name': encodeURIComponent('צילום מסך.png') });
    assert.equal(up.status, 200);
    const a = up.json.upload;
    assert.match(a.id, /^u-/);
    assert.deepEqual({ name: a.name, mime: a.mime, bytes: a.bytes }, { name: 'צילום מסך.png', mime: 'image/png', bytes: PNG.length });
    assert.equal(a.path, undefined, 'the path is for the worker, not the app');
    const path = env.hq.uploads.get(a.id)!.path;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(env.cfg.stateDir, 'uploads')).mode & 0o777, 0o700);

    const got = await fetch(`${env.base}/api/uploads/${a.id}`, { headers: env.auth });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.equal((await fetch(`${env.base}/api/uploads/${a.id}`)).status, 401);
    assert.equal((await fetch(`${env.base}/api/uploads/u-nope`, { headers: env.auth })).status, 404);

    // An image alone is a message; an id that was never uploaded is refused, not dropped.
    assert.equal((await env.tell({ to: 'eli', attachments: ['u-nope'] })).status, 400);
    assert.equal((await env.tell({ to: 'eli', attachments: 'x' })).status, 400);
    assert.equal((await env.tell({ to: 'eli', attachments: [] })).status, 400, 'no text and no image');
    const t = await env.tell({ msg_id: 'img-1', to: 'eli', body: 'מה רואים כאן?', attachments: [a.id] });
    assert.equal(t.status, 200);
    assert.deepEqual(t.json.message.attachments, [{ id: a.id, name: 'צילום מסך.png', mime: 'image/png', bytes: PNG.length }]);
    await until(() => env.hq.mailbox.get('img-1')!.state === 'delivered', 3000, 'delivered');
    const sent = env.launcher.hosts.get('eli-1')!.sent.find((s) => s.msgId === 'img-1')!;
    assert.equal(sent.text, `[הודעה מ-רן (owner) · דחיפות: רגילה · img-1]\nמה רואים כאן?\n[תמונה מצורפת: ${path} · כדי לראות אותה, פותחים את הנתיב ב-Read]`);

    const only = await env.tell({ msg_id: 'img-2', to: 'eli', attachments: [a.id] });
    assert.equal(only.status, 200);
    assert.equal(only.json.message.body, '');
    await until(() => env.launcher.hosts.get('eli-1')!.sent.some((s) => s.msgId === 'img-2'), 3000, 'img-2 sent');
    assert.match(env.launcher.hosts.get('eli-1')!.sent.find((s) => s.msgId === 'img-2')!.text, /· img-2\]\n\[תמונה מצורפת: /);

    // History carries them too, so the app can draw the bubble after a reload.
    const res = await fetch(`${env.base}/api/messages?identity=eli`, { headers: env.auth });
    const msgs = ((await res.json()) as { messages: { id: string; attachments: unknown }[] }).messages;
    assert.equal((msgs.find((m) => m.id === 'img-1')!.attachments as unknown[]).length, 1);
    assert.equal(msgs.find((m) => m.id === 'img-2')!.attachments !== null, true);
  } finally { await env.cleanup(); }
});

test('an image as the answer to a question: the ask closes and the asker gets the image', async () => {
  const env = await apiEnv();
  try {
    const a = (await env.upload(PNG)).json.upload;
    env.hq.mailbox.ask({ msg_id: 'ask-img', from: 'eli', question: 'איך זה נראה אצלך?' });
    const res = await fetch(`${env.base}/api/asks/ask-img/answer`, { method: 'POST', headers: { ...env.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ attachments: [a.id], by: 'owner' }) });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ask: { state: string } }).ask.state, 'answered');
    const m = env.hq.mailbox.get('ask-img-answer')!;
    assert.equal(m.attachments?.[0]?.id, a.id);
    assert.match(m.body, /^תשובה לשאלה ask-img: \(תמונה מצורפת\)$/);
    const bad = await fetch(`${env.base}/api/asks/ask-img/answer`, { method: 'POST', headers: { ...env.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ attachments: ['u-nope'] }) });
    assert.equal(bad.status, 200, 'already answered: returned as it is');
    assert.equal((await env.upload(PNG, { 'x-file-name': '%E0%A4%A' })).status, 400, 'a broken file name is the client\'s error');
  } finally { await env.cleanup(); }
});
