// B.9 tab handoff: the link, "מחכה לך", the login lock, preview bots, "סיימתי" waking the requester, expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import WebSocket from 'ws';
import { makeEnv, until } from './helpers.ts';
import { Hq } from '../src/hq.ts';
import { siteOf } from '../src/tab/handoffs.ts';
import { OWNER } from '@company/shared';

async function tabEnv() {
  const env = await makeEnv({ noStart: true, cfg: { tab: { listen: '127.0.0.1:0', baseUrl: 'https://tab.example', cdpUrl: 'http://127.0.0.1:1', ttlMin: 10 } } });
  await env.hq.start({ listen: true, timers: false });
  const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
  const api = `http://127.0.0.1:${env.hq.port}`;
  const pub = `http://127.0.0.1:${env.hq.tabPort}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(api + path, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const phonePath = (link: string) => new URL(link).pathname;
  // The app's device token: the only caller that is him (#208).
  let device = '';
  const callAsOwner = async (method: string, path: string, body?: unknown) => {
    if (!device) {
      const code = (await call('POST', '/api/devices/pair', {})).json.code;
      const paired = await fetch(`${api}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'טלפון' }) });
      device = ((await paired.json()) as { token: string }).token;
    }
    const res = await fetch(api + path, { method, headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...env, call, callAsOwner, pub, phonePath };
}

/** Plain node:http, not fetch: fetch sets its own sec-fetch-mode (cors), which is what the page refuses. */
function get(url: string, opts: { headers?: Record<string, string> } = {}): Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    request(url, { headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({
        status: res.statusCode!,
        headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
        text: async () => body,
      }));
    }).on('error', reject).end();
  });
}

const phoneUa = { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/141 Mobile', 'sec-fetch-mode': 'navigate' };

test('siteOf: the login lock is per site, not per host', () => {
  assert.equal(siteOf('https://accounts.google.com/x'), 'google.com');
  assert.equal(siteOf('https://github.com/login'), 'github.com');
  assert.equal(siteOf('https://www.misim.gov.il/a'), 'misim.gov.il');
  assert.equal(siteOf('https://bank.co.il'), 'bank.co.il');
  assert.equal(siteOf('not a url'), '');
});

test('handoff: link in "מחכה לך" (login, pushes), one live login per site', async () => {
  const env = await tabEnv();
  try {
    const r = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login', what: 'להתחבר ל-GitHub' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.link, /^https:\/\/tab\.example\/h\/[A-Za-z0-9_-]{32}$/);
    assert.equal(env.tabBrowser.opened.length, 0, 'the worker\'s own tab, not a new window');
    const item = env.hq.inbox.get(r.json.inbox_id)!;
    assert.equal(item.kind, 'login');
    assert.equal(item.title, 'github.com');
    assert.equal(item.link, r.json.link);
    assert.equal(item.from_identity, 'amit');
    // No push subscription in tests → the Telegram fallback, and it carries the link.
    await until(() => env.telegrams.length > 0, 2000, 'telegram');
    assert.ok(env.telegrams[0]!.includes(r.json.link));

    const other = await env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://gist.github.com/', what: 'x' });
    assert.equal(other.status, 409);
    assert.equal(other.json.busy.from, 'amit');
    assert.equal(other.json.busy.domain, 'github.com');
    const again = await env.call('POST', '/v1/handoffs', { identity: 'amit', url: 'https://github.com/login', what: 'x' });
    assert.equal(again.status, 409, 'no second link for the same login');
    assert.equal(again.json.busy.id, r.json.handoff.id);
    const elsewhere = await env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://pay.example.com/login', what: 'x' });
    assert.equal(elsewhere.status, 200);
    assert.deepEqual(env.tabBrowser.opened, ['https://pay.example.com/login'], 'no tab given → a window of its own');
  } finally { await env.cleanup(); }
});

test('handoff: the worker\'s tab is handed over whatever it shows; a blank one fails at once (#283, 31/10 gil)', async () => {
  const env = await tabEnv();
  try {
    // gil, 31/10: his current page was a local image, and hq answered "url must be http(s)": no row, no card,
    // and browser_ask_user waited out its timeout while nobody had been asked.
    env.tabBrowser.targets.add('image-tab');
    env.tabBrowser.urls.set('image-tab', 'file:///srv/browser-work/kl-docs/passport.jpg');
    const file = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'image-tab', url: 'file:///srv/browser-work/kl-docs/passport.jpg', what: 'לאשר את התמונה', need: 'other' });
    assert.equal(file.status, 200, JSON.stringify(file.json));
    assert.equal(env.tabBrowser.opened.length, 0, 'his own tab, not a new window');
    const item = env.hq.inbox.get(file.json.inbox_id)!;
    assert.equal(item.kind, 'login');
    assert.equal(item.body, 'לאשר את התמונה');
    assert.equal(item.link, file.json.link);

    // browser-memory's own marker tab (or a new tab): a white page with only "סיימתי" on it. Refused, with why.
    env.tabBrowser.targets.add('marker');
    env.tabBrowser.urls.set('marker', 'about:blank#browser-memory-2933875-mvwei8ui');
    const before = env.hq.store.db.prepare('SELECT COUNT(*) AS n FROM tab_handoffs').get() as { n: number };
    const blank = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'marker', url: 'about:blank#browser-memory-2933875-mvwei8ui', what: 'x' });
    assert.equal(blank.status, 400);
    assert.match(blank.json.error, /blank.*select the tab/);
    assert.equal((env.hq.store.db.prepare('SELECT COUNT(*) AS n FROM tab_handoffs').get() as { n: number }).n, before.n, 'no handoff row');
    assert.equal(env.tabBrowser.opened.length, 0);

    // No tab of its own: hq can only open a window at an http(s) url.
    const noTab = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'gone', url: 'file:///x.jpg', what: 'x' });
    assert.equal(noTab.status, 400);
    assert.match(noTab.json.error, /not open/);
  } finally { await env.cleanup(); }
});

test('handoff: preview bots never claim the link; the first phone owns it; "סיימתי" wakes the waiting tool', async () => {
  const env = await tabEnv();
  try {
    const r = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login', what: 'x' });
    const path = env.phonePath(r.json.link);
    const bot = await get(env.pub + path, { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' } });
    assert.equal(bot.status, 200);
    assert.equal(bot.headers.get('set-cookie'), null);
    assert.match(await bot.text(), /const STATE = 'expired'/);
    const prefetch = await get(env.pub + path, { headers: { 'user-agent': phoneUa['user-agent'], 'sec-fetch-mode': 'no-cors' } });
    assert.equal(prefetch.headers.get('set-cookie'), null, 'a non-navigation fetch does not claim it either');

    const page = await get(env.pub + path, { headers: phoneUa });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /const STATE = 'live'/);
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(cookie, /^hqt_h[0-9a-f]+=/);
    const second = await get(env.pub + path, { headers: phoneUa });
    assert.equal(second.status, 403, 'another device');
    const reload = await get(env.pub + path, { headers: { ...phoneUa, cookie } });
    assert.equal(reload.status, 200, 'the same phone can reload');

    // The worker's browser_ask_user is blocked on this long-poll.
    const waiting = env.call('GET', `/v1/handoffs/${r.json.handoff.id}?wait=20000`);
    const noCookie = new WebSocket(`ws://127.0.0.1:${env.hq.tabPort}${path.replace('/h/', '/ws/')}`);
    await new Promise((res) => noCookie.on('error', res).on('close', res));
    const ws = new WebSocket(`ws://127.0.0.1:${env.hq.tabPort}${path.replace('/h/', '/ws/')}?w=412&h=800&dpr=3`, { headers: { cookie } });
    const msgs: any[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    await new Promise((res) => ws.on('open', res));
    await until(() => env.tabBrowser.phones.length === 1, 2000, 'phone attached');
    assert.deepEqual(env.tabBrowser.phones[0]!.size, { w: 412, h: 800, dsf: 2 });
    assert.equal(env.tabBrowser.phones[0]!.targetId, 'agent-tab');
    ws.send(JSON.stringify({ t: 'done' }));
    const w = await waiting;
    assert.equal(w.json.handoff.state, 'done');
    assert.equal(w.json.handoff.ended_by, 'phone');
    assert.equal(w.json.handoff.final_url, 'https://github.com/');
    await until(() => msgs.some((m) => m.t === 'finished'), 2000, 'phone told');
    assert.equal(env.hq.inbox.get(r.json.inbox_id)!.state, 'resolved');
    assert.deepEqual(env.tabBrowser.closed, [], 'the worker\'s own tab stays open');
    // The waiting tool was the wake-up: no extra message on top of it.
    assert.equal(env.hq.mailbox.list('amit').filter((m) => m.from_identity === OWNER).length, 0);
    assert.equal((await get(env.pub + path, { headers: { ...phoneUa, cookie } })).status, 410, 'burnt');
    // The site is free again.
    assert.equal((await env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://github.com/login' })).status, 200);
  } finally { await env.cleanup(); }
});

test('handoff: "סיימתי" in the app with nothing waiting wakes the worker by mail (now)', async () => {
  const env = await tabEnv();
  try {
    const r = await env.call('POST', '/v1/handoffs', { identity: 'amit', url: 'https://pay.example.com/login', what: 'קוד' });
    const done = await env.callAsOwner('POST', `/api/inbox/${r.json.inbox_id}/done`, { note: 'done' });
    assert.equal(done.status, 200);
    assert.equal(env.hq.tab.get(r.json.handoff.id)!.state, 'done');
    const msg = env.hq.mailbox.list('amit').find((m) => m.from_identity === OWNER);
    assert.ok(msg, 'the requester hears it');
    assert.equal(msg!.priority, 'now');
    await until(() => env.tabBrowser.closed.length === 1, 2000, 'window closed');
    assert.deepEqual(env.tabBrowser.closed, ['win-1'], 'the window hq opened is closed');
    assert.equal(env.tabBrowser.released.at(-1)!.tell, 'finished');
    assert.equal(env.hq.inbox.get(r.json.inbox_id)!.link, null, 'a spent link does not stay in the store');
  } finally { await env.cleanup(); }
});

test('handoff: a worker closing the handoff item is not told on as "רן סיים" (#208)', async () => {
  const env = await tabEnv();
  try {
    const r = await env.call('POST', '/v1/handoffs', { identity: 'amit', url: 'https://pay.example.com/login', what: 'קוד' });
    assert.equal((await env.call('POST', `/api/inbox/${r.json.inbox_id}/done`, { note: 'עשיתי', from: 'eli' })).status, 200);
    assert.equal(env.hq.tab.get(r.json.handoff.id)!.state, 'done');
    const mails = env.hq.mailbox.list('amit');
    assert.ok(!mails.some((m) => m.from_identity === OWNER), 'nothing written as him');
    assert.ok(!mails.some((m) => /רן (סיים|דחה)/.test(m.body)));
    // A declined handoff closed by a worker: told in the worker's name, never his.
    const b = await env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://github.com/login' });
    assert.equal((await env.call('POST', `/api/inbox/${b.json.inbox_id}/dismiss`, { from: 'adi' })).status, 200);
    assert.ok(!env.hq.mailbox.list('eli').some((m) => m.from_identity === OWNER || /רן (סיים|דחה)/.test(m.body)));
  } finally { await env.cleanup(); }
});

test('handoff: expires after its TTL (410, out of "מחכה לך"); the worker\'s watcher can end it', async () => {
  const env = await tabEnv();
  try {
    const a = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login' });
    const b = await env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://pay.example.com/login' });
    const end = await env.call('POST', `/v1/handoffs/${b.json.handoff.id}/end`, { state: 'done', final_url: 'https://pay.example.com/home' });
    assert.equal(end.json.handoff.state, 'done');
    assert.equal(end.json.handoff.ended_by, 'worker');
    assert.equal(env.hq.mailbox.list('eli').filter((m) => m.from_identity === OWNER).length, 0, 'it saw it itself');
    env.clock.advance(11 * 60_000);
    await env.hq.tab.sweep();
    assert.equal(env.hq.tab.get(a.json.handoff.id)!.state, 'expired');
    assert.equal(env.hq.inbox.get(a.json.inbox_id)!.state, 'dismissed');
    assert.equal((await get(env.pub + env.phonePath(a.json.link), { headers: phoneUa })).status, 410);
    assert.equal((await env.call('GET', '/v1/handoffs/h-00000000')).status, 404);
  } finally { await env.cleanup(); }
});

test('handoff: the agent closing its tab ends the handoff', async () => {
  const env = await tabEnv();
  try {
    const a = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login' });
    env.tabBrowser.onTargetGone('agent-tab');
    await until(() => env.hq.tab.get(a.json.handoff.id)!.state === 'closed', 2000, 'closed');
    assert.equal(env.hq.inbox.get(a.json.inbox_id)!.state, 'dismissed');
  } finally { await env.cleanup(); }
});

test('handoff: "לא עכשיו"/dismiss and expiry with nothing waiting still reach the worker', async () => {
  const env = await tabEnv();
  try {
    const a = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login' });
    assert.equal((await env.callAsOwner('POST', `/api/inbox/${a.json.inbox_id}/dismiss`, {})).status, 200);
    assert.equal(env.hq.tab.get(a.json.handoff.id)!.state, 'cancelled');
    assert.equal(env.hq.inbox.get(a.json.inbox_id)!.state, 'dismissed');
    assert.ok(env.hq.mailbox.list('amit').some((m) => m.from_identity === OWNER && /דחה/.test(m.body)), 'declined, said so');
    await until(() => env.tabBrowser.released.some((x) => x.tell === 'cancelled'), 2000, 'phone told cancelled');

    const b = await env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://pay.example.com/login' });
    env.clock.advance(11 * 60_000);
    await env.hq.tab.sweep();
    const note = env.hq.mailbox.list('eli').find((m) => m.from_identity === 'hq');
    assert.ok(note && /פג/.test(note.body), 'the worker was told its link expired');
    assert.equal(env.hq.inbox.get(b.json.inbox_id)!.state, 'dismissed');
  } finally { await env.cleanup(); }
});

test('handoff: a long-poll whose caller went away is not a waiter (the worker gets mail)', async () => {
  const env = await tabEnv();
  try {
    const a = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login' });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const ac = new AbortController();
    const poll = fetch(`http://127.0.0.1:${env.hq.port}/v1/handoffs/${a.json.handoff.id}?wait=20000`,
      { headers: { authorization: `Bearer ${token}` }, signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await poll;
    await new Promise((r) => setTimeout(r, 100));
    await env.callAsOwner('POST', `/api/inbox/${a.json.inbox_id}/done`, {});
    assert.ok(env.hq.mailbox.list('amit').some((m) => m.from_identity === OWNER), 'mail, since nobody waits any more');
  } finally { await env.cleanup(); }
});

test('handoff: the login lock holds across the await that opens a window', async () => {
  const env = await tabEnv();
  try {
    const slow = env.tabBrowser.openWindow.bind(env.tabBrowser);
    env.tabBrowser.openWindow = async (url: string) => { await new Promise((r) => setTimeout(r, 50)); return slow(url); };
    const [x, y] = await Promise.all([
      env.call('POST', '/v1/handoffs', { identity: 'amit', url: 'https://bank.co.il/login' }),
      env.call('POST', '/v1/handoffs', { identity: 'eli', url: 'https://www.bank.co.il/' }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal(env.tabBrowser.opened.length, 2);
    assert.equal(env.tabBrowser.closed.length, 1, 'the loser\'s window is closed again');
  } finally { await env.cleanup(); }
});

test('handoff: a live link survives an hq restart (same phone, same cookie)', async () => {
  const env = await tabEnv();
  let hq2: Hq | null = null;
  try {
    const a = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login' });
    const path = env.phonePath(a.json.link);
    const page = await get(env.pub + path, { headers: phoneUa });
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    await env.hq.stop();
    hq2 = new Hq(env.cfg, { tabBrowser: env.tabBrowser, launcher: env.launcher, now: env.clock.now, telegram: async () => {} });
    await hq2.start({ listen: true, timers: false });
    const pub2 = `http://127.0.0.1:${hq2.tabPort}`;
    assert.equal((await get(pub2 + path, { headers: { ...phoneUa, cookie } })).status, 200);
    assert.equal((await get(pub2 + path, { headers: phoneUa })).status, 403);
  } finally { await hq2?.stop(); await env.cleanup(); }
});

test('handoff: after a reconnect, a live handoff whose tab is gone ends, and the worker hears it', async () => {
  const env = await tabEnv();
  try {
    const a = await env.call('POST', '/v1/handoffs', { identity: 'amit', target: 'agent-tab', url: 'https://github.com/login' });
    env.tabBrowser.targets.delete('agent-tab'); // Chrome restarted without it
    env.tabBrowser.onConnected!();
    await until(() => env.hq.tab.get(a.json.handoff.id)!.state === 'closed', 2000, 'closed');
    assert.equal(env.hq.tab.get(a.json.handoff.id)!.ended_by, 'tab-gone');
    assert.ok(env.hq.mailbox.list('amit').some((m) => m.from_identity === 'hq' && /נסגר/.test(m.body)));
  } finally { await env.cleanup(); }
});
