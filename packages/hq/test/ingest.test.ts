import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { makeEnv, until } from './helpers.ts';

function post(socketPath: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const entry = (op: WalEntry['op'], args: Record<string, unknown>, id: string, identity = 'eli'): WalEntry =>
  ({ id, v: 1, ts: new Date().toISOString(), identity, shift: `${identity}-1`, sessionId: null, op, args });

async function ingestEnv() {
  const env = await makeEnv({ noStart: true, deps: { ticketer: async (repo, title) => `https://github.com/${repo}/issues/1#${encodeURIComponent(title)}` } });
  const mem = join(env.cfg.companyDir, '..', 'memory', 'projects', 'lumo');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'deploy.md'), '# פריסות של לומו\n\nה-rollout של server דורש kubectl rollout status לפני מיזוג.\n');
  await env.hq.start({ listen: true, timers: false });
  return { ...env, sock: join(env.cfg.stateDir, 'hq.sock') };
}

test('ingest socket: 0600, ops are idempotent on id, tell/ask/request_go land where they should', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock } = env;
    assert.equal(statSync(sock).mode & 0o777, 0o600);
    const t = await post(sock, '/v1/ops', entry('tell', { to: 'rotem', body: 'תבדקי את ה-API', urgency: 'now' }, 'eli-1:01'));
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, true);
    assert.equal(t.json.ref, 'eli-1:01');
    const m = hq.mailbox.get('eli-1:01')!;
    assert.equal(m.from_identity, 'eli');
    assert.equal(m.priority, 'now');
    assert.equal(m.urgency, 'urgent');
    const again = await post(sock, '/v1/ops', entry('tell', { to: 'rotem', body: 'תבדקי את ה-API', urgency: 'now' }, 'eli-1:01'));
    assert.deepEqual(again.json, t.json, 'replay → same ack');
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE id = 'eli-1:01'`).get() as { n: number }).n, 1);

    const a = await post(sock, '/v1/ops', entry('ask', { question: 'לשלם?', blocking: true, options: ['כן', 'לא'] }, 'eli-1:02'));
    assert.equal(hq.mailbox.getAsk(a.json.ref)!.blocking, true);
    assert.ok(hq.inbox.open().some((i) => i.kind === 'ask' && i.ref === 'eli-1:02'));

    await post(sock, '/v1/ops', entry('request_go', { what: 'פריסה לפרודקשן', pr: '#12', risk: 'high' }, 'ac-ceo-1:01', 'ac-ceo'));
    const go = hq.inbox.open().find((i) => i.kind === 'go')!;
    assert.equal(go.urgency, 'urgent');
    assert.match(go.body, /PR: #12/);
    await until(() => env.telegrams.some((x) => /GO: פריסה לפרודקשן/.test(x)), 2000, 'GO pushed (telegram fallback)');

    assert.equal((await post(sock, '/v1/ops', { ...entry('tell', {}, 'x'), v: 2 })).status, 400);
    assert.equal((await post(sock, '/v1/ops', entry('tell', { to: 'rotem' }, 'eli-1:03'))).status, 400, 'missing body = permanent reject');
    assert.equal((await post(sock, '/v1/ops', { ...entry('tell', {}, 'eli-1:04'), op: 'rm_rf' })).status, 400);
    assert.equal(hq.store.db.prepare(`SELECT 1 FROM ops WHERE id = 'eli-1:03'`).get(), undefined, 'rejected ops are not stored');
  } finally { await env.cleanup(); }
});

test('handoff feeds prime.json of the next shift; open_ticket reports back; recall finds memory', async () => {
  const env = await ingestEnv();
  try {
    const { hq, sock, launcher } = env;
    await post(sock, '/v1/ops', entry('handoff', { state: 'תיקון ה-race מוזג', next: ['להסיר retry מהלקוח'], reason: 'rotation' }, 'eli-1:10'));
    hq.mailbox.tell({ msg_id: 'p-1', to: 'eli', body: 'המשך מאיפה שעצרת' });
    await until(() => launcher.launches.length === 1);
    const prime = JSON.parse(readFileSync(join(env.cfg.stateDir, 'shifts', 'eli-1', 'prime.json'), 'utf8'));
    assert.equal(prime.v, 1);
    assert.match(prime.handoff, /state: תיקון ה-race מוזג/);
    assert.match(prime.handoff, /- להסיר retry מהלקוח/);
    assert.match(prime.inbox, /p-1/);
    // topRecord: the body of the single most relevant memory record (bet 9).
    hq.mailbox.tell({ msg_id: 'p-2', to: 'rotem', body: 'בדקי rollout kubectl של לומו' });
    await until(() => launcher.launches.some((l) => l.identity === 'rotem'));
    const primeR = JSON.parse(readFileSync(join(env.cfg.stateDir, 'shifts', 'rotem-1', 'prime.json'), 'utf8'));
    assert.match(primeR.topRecord, /^\[memory\/projects\/lumo\/deploy\.md\]\n# פריסות של לומו/);
    const total = ['handoff', 'directives', 'topRecord', 'memoryIndex', 'inbox', 'pointers'].reduce((n, k) => n + (primeR[k]?.length ?? 0), 0);
    assert.ok(total <= 10_000);

    await post(sock, '/v1/ops', entry('open_ticket', { repo: 'hive-owner/lumo', title: 'תשלומים נכשלים', body: '...' }, 'eli-1:11'));
    await until(() => !!hq.mailbox.get('eli-1:11-ticket'), 2000, 'ticket reply');
    assert.match(hq.mailbox.get('eli-1:11-ticket')!.body, /github.com\/hive-owner\/lumo\/issues\/1/);

    const r = await post(sock, '/v1/recall', { identity: 'eli', shift: 'eli-1', query: 'rollout kubectl', scope: 'project:lumo' });
    assert.equal(r.status, 200);
    assert.equal(r.json.items[0].ref, 'memory/projects/lumo/deploy.md');
    const h = await post(sock, '/v1/recall', { identity: 'eli', shift: 'eli-1', query: 'race' });
    assert.ok(h.json.items.some((i: { ref: string }) => i.ref === 'eli-1:10'));
  } finally { await env.cleanup(); }
});

test('ingest over TCP requires the token', async () => {
  const env = await ingestEnv();
  try {
    const res = await fetch(`http://127.0.0.1:${env.hq.port}/v1/ops`, { method: 'POST', body: JSON.stringify(entry('status', { state: 'idle' }, 'eli-1:20')) });
    assert.equal(res.status, 401);
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const ok = await fetch(`http://127.0.0.1:${env.hq.port}/v1/ops`, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(entry('status', { state: 'idle' }, 'eli-1:20')) });
    assert.equal(ok.status, 200);
  } finally { await env.cleanup(); }
});

test('delivery states from the host: delivered → started = seen; deltas stream live-only', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    const live: { type: string; seq: number }[] = [];
    hq.store.onEvent((e) => live.push(e));
    hq.mailbox.tell({ msg_id: 'd-1', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('d-1')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('d-1', 'started');
    await until(() => hq.mailbox.get('d-1')!.state === 'seen', 2000, 'started → seen');
    host.live({ t: 'delta', ev: { kind: 'text_delta', text: 'של' } });
    await until(() => live.some((e) => e.type === 'engine.delta'), 2000, 'delta published');
    assert.equal(live.find((e) => e.type === 'engine.delta')!.seq, 0);
    assert.equal(hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'engine.delta'`).get(), undefined, 'not persisted');

    // Re-send after an hq crash is idempotent in the host: the reply's state is applied.
    hq.store.db.prepare(`UPDATE messages SET state = 'queued' WHERE id = 'd-1'`).run();
    await hq.mailbox.deliver('d-1');
    assert.equal(hq.mailbox.get('d-1')!.state, 'seen', 'host reports it as already started');
    assert.equal(host.sent.filter((x) => x.msgId === 'd-1').length, 1, 'nothing written twice');
  } finally { await env.cleanup(); }
});
