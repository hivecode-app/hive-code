// HTTP + WebSocket API on 127.0.0.1 (B.8). Token auth on everything except GET /health (heartbeat) and
// /api/auth/* (getting a device token: passkey or pairing code, auth.ts). A token is either hq's own
// api-token (stays on the server) or a device token. The app uses this through Caddy; mcp-company and
// hooks use it for writes (idempotent by msg_id). POST /api/dictate/transcribe streams to dictate-server (dictate.ts).
// GET /api/app/latest and /api/app/apk/:code: the in-app update of the Android app (app-release.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Hq } from './hq.ts';
import { AuthError, type Caller } from './auth.ts';
import { proxyDictate } from './dictate.ts';
import { MUTE_FOR } from './conversations.ts';
import { readRaw, UploadError } from './uploads.ts';
import { OWNER } from '@company/shared';

export function loadOrCreateToken(stateDir: string): string {
  if (process.env.HQ_TOKEN) return process.env.HQ_TOKEN;
  const file = join(stateDir, 'api-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(stateDir, { recursive: true });
  const t = randomBytes(32).toString('base64url');
  writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

class HttpError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (ctx: { req: IncomingMessage; url: URL; params: string[]; body: () => Promise<Record<string, unknown>>; caller: Caller }) => unknown | Promise<unknown>;

function tokenOk(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'body must be a JSON object'));
        resolve(v as Record<string, unknown>);
      } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const str = (v: unknown, name: string, required = true): string | undefined => {
  if (v == null || v === '') { if (required) throw new HttpError(400, `${name} is required`); return undefined; }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  return v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined => {
  if (v == null) return undefined;
  if (!allowed.includes(v as T)) throw new HttpError(400, `${name} must be one of ${allowed.join('|')}`);
  return v as T;
};
const deviceName = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().slice(0, 80) : '';
  return s || 'מכשיר';
};
const strings = (v: unknown, name: string): string[] | undefined => {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${name} must be an array of strings`);
  return v as string[];
};
/** Text may be left out only when images come instead (an empty list is not images). */
const hasFiles = (b: Record<string, unknown>): boolean => Array.isArray(b.attachments) && b.attachments.length > 0;
const URGENCIES = ['urgent', 'normal', 'low'] as const;
const PRIORITIES = ['now', 'next', 'later'] as const;
const SEEN_SCREENS = ['chats'] as const;

export function health(hq: Hq) {
  const lastSweep = Number(hq.store.getMeta('last_sweep_at') ?? 0);
  const age = lastSweep ? hq.store.now() - lastSweep : null;
  const live = (hq.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state = 'live'`).get() as { n: number }).n;
  const ok = age != null && age < hq.cfg.timers.schedulerMs * 3;
  return { ok, last_sweep_at: lastSweep || null, sweep_age_ms: age, live_shifts: live, schema: hq.store.schemaVersion };
}

export function buildRoutes(hq: Hq): [string, RegExp, Handler][] {
  const r: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) => r.push([method, new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), h]);

  route('GET', '/api/org', () => ({ identities: hq.board(), teams: hq.teams() }));
  // awaiting: "מה לבדוק" (#108), finished tasks that wait for a deploy or for him to check (awaiting.ts).
  route('GET', '/api/board', () => ({ identities: hq.board(), tasks: hq.scheduler.tasks(), awaiting: hq.awaiting.list(), projects: hq.projects(),
    slots: hq.scheduler.slots(), probes: hq.probes.summary() }));

  route('GET', '/api/inbox', () => ({ items: hq.inbox.open() }));
  route('POST', '/api/inbox/:id/ack', ({ params }) => ({ ok: hq.inbox.ack(Number(params[0])) }));
  // "לא עכשיו" and its undo ({on:false}): kept here, so a refresh or another device doesn't bring the card back (#74).
  route('POST', '/api/inbox/:id/snooze', async ({ params, body }) => {
    const b = await body();
    const id = Number(params[0]);
    const item = hq.inbox.get(id);
    if (!item) throw new HttpError(404, `no inbox item ${id}`);
    if (item.state !== 'open') throw new HttpError(409, `inbox item ${id} is already handled`);
    hq.inbox.snooze(id, b.on !== false);
    return { item: hq.inbox.get(id) };
  });
  // Workers (mcp-company request_go, browser-memory tab handoff) put "blocked on you" items here.
  route('POST', '/api/inbox', async ({ body }) => {
    const b = await body();
    const kind = oneOf(b.kind, ['go', 'login', 'incident'] as const, 'kind');
    if (!kind) throw new HttpError(400, 'kind is required');
    const from = str(b.from, 'from')!;
    const key = str(b.msg_id, 'msg_id', false);
    return { item: hq.inbox.add({ kind, from_identity: from, title: str(b.title, 'title')!, body: str(b.body, 'body', false),
      urgency: oneOf(b.urgency, URGENCIES, 'urgency'), blocking: b.blocking !== false, ref: str(b.ref, 'ref', false),
      headline: str(b.headline, 'headline', false), dedupe_key: key ? `api:${key}` : null }) };
  });
  // He finished it ("סיימתי") or declined: the requester hears it now, through its mailbox.
  route('POST', '/api/inbox/:id/done', async ({ params, body }) => {
    const b = await body();
    // A tab handoff ends as one: the view is released, the link burnt, the requester woken (tab/handoffs.ts).
    if (await hq.tab.fromInbox(Number(params[0]), false)) return { item: hq.inbox.get(Number(params[0])), message: null };
    try { return hq.mailbox.complete(Number(params[0]), { note: str(b.note, 'note', false) }); }
    catch (e) { throw new HttpError(404, (e as Error).message); }
  });
  // His own words on an open question or GO, typed in the conversation: the item closes with them.
  route('POST', '/api/inbox/:id/answer', async ({ params, body }) => {
    const b = await body();
    const answer = str(b.answer, 'answer', !hasFiles(b)) ?? '';
    try { return hq.mailbox.reply(Number(params[0]), answer, strings(b.attachments, 'attachments')); }
    catch (e) {
      const why = (e as Error).message;
      throw new HttpError(/no inbox item/.test(why) ? 404 : /already handled/.test(why) ? 409 : 400, why);
    }
  });
  route('POST', '/api/inbox/:id/dismiss', async ({ params, body }) => {
    const b = await body();
    if (await hq.tab.fromInbox(Number(params[0]), true)) return { item: hq.inbox.get(Number(params[0])), message: null };
    try { return hq.mailbox.complete(Number(params[0]), { note: str(b.note, 'note', false), declined: true }); }
    catch (e) { throw new HttpError(404, (e as Error).message); }
  });

  route('GET', '/api/messages', ({ url }) => {
    const identity = str(url.searchParams.get('identity'), 'identity')!;
    const before = url.searchParams.get('before');
    return { messages: hq.mailbox.list(identity, Number(url.searchParams.get('limit') ?? 200), before ? Number(before) : undefined) };
  });
  route('POST', '/api/messages/tell', async ({ body }) => {
    const b = await body();
    return { message: hq.mailbox.tell({
      msg_id: str(b.msg_id, 'msg_id', false), from: str(b.from, 'from', false), to: str(b.to, 'to')!, body: str(b.body, 'body', !hasFiles(b)) ?? '',
      urgency: oneOf(b.urgency, URGENCIES, 'urgency'), priority: oneOf(b.priority, PRIORITIES, 'priority'), ref: str(b.ref, 'ref', false),
      attachments: strings(b.attachments, 'attachments'),
    }) };
  });
  route('POST', '/api/messages/:id/handled', ({ params }) => ({ ok: hq.mailbox.markHandled(decodeURIComponent(params[0]!)) }));

  // His conversations as in WhatsApp (conversations.ts): unread per conversation, read on any device, mute.
  route('GET', '/api/conversations', () => ({ conversations: hq.conversations.list(), unread_total: hq.conversations.unreadTotal() }));
  route('POST', '/api/conversations/:id/read', ({ params }) => ({ conversation: hq.conversations.markRead(decodeURIComponent(params[0]!)) }));
  route('POST', '/api/conversations/:id/mute', async ({ params, body }) => {
    const b = await body();
    const duration = oneOf(b.for, MUTE_FOR, 'for');
    if (!duration) throw new HttpError(400, 'for is required');
    return { conversation: hq.conversations.mute(decodeURIComponent(params[0]!), duration) };
  });
  // When he last left a screen, one value for all his devices: the chats screen's "מאז שהיית פה" is what
  // happened after it. It only moves forward, and every device hears of it (`seen.changed`).
  route('GET', '/api/seen', () => ({ seen: Object.fromEntries(SEEN_SCREENS.map((s) => [s, Number(hq.store.getMeta(`seen:${s}`)) || null])) }));
  route('PUT', '/api/seen/:screen', async ({ params, body }) => {
    const screen = oneOf(decodeURIComponent(params[0]!), SEEN_SCREENS, 'screen')!;
    const b = await body();
    const now = hq.store.now();
    const at = typeof b.at === 'number' && Number.isFinite(b.at) ? Math.min(b.at, now) : now;
    const prev = Number(hq.store.getMeta(`seen:${screen}`)) || 0;
    if (at <= prev) return { screen, at: prev };
    hq.store.setMeta(`seen:${screen}`, String(at));
    hq.store.emit('seen.changed', null, { screen, at });
    return { screen, at };
  });
  // The conversation open on this device's screen right now (null = none, or the app is in the background):
  // a message there doesn't alert him. Said again every 30 s while it stays open.
  route('PUT', '/api/presence', async ({ body, caller }) => {
    const b = await body();
    hq.conversations.setScreen(caller.kind === 'device' ? `device:${caller.id}` : `admin:${str(b.device, 'device', false) ?? ''}`,
      str(b.identity, 'identity', false) ?? null);
    return { ok: true };
  });

  route('GET', '/api/asks', () => ({ asks: hq.mailbox.openAsks() }));
  route('POST', '/api/asks', async ({ body }) => {
    const b = await body();
    return { ask: hq.mailbox.ask({
      msg_id: str(b.msg_id, 'msg_id', false), from: str(b.from, 'from')!, question: str(b.question, 'question')!,
      headline: str(b.headline, 'headline', false), options: Array.isArray(b.options) ? b.options.map(String) : [], blocking: b.blocking === true,
      urgency: oneOf(b.urgency, URGENCIES, 'urgency'),
    }) };
  });
  route('POST', '/api/asks/:id/answer', async ({ params, body }) => {
    const b = await body();
    const by = oneOf(b.by, ['owner', 'manager'] as const, 'by') ?? 'owner';
    try {
      return { ask: hq.mailbox.answer(decodeURIComponent(params[0]!), str(b.answer, 'answer', !hasFiles(b)) ?? '', by, str(b.why, 'why', false),
        strings(b.attachments, 'attachments')) };
    } catch (e) { throw new HttpError(/no ask/.test((e as Error).message) ? 404 : /must be/.test((e as Error).message) ? 400 : 409, (e as Error).message); }
  });

  route('GET', '/api/shifts', () => ({ shifts: hq.shifts.active() }));
  route('POST', '/api/shifts/start', async ({ body }) => {
    const b = await body();
    const identity = str(b.identity, 'identity')!;
    if (!hq.identityExists(identity)) throw new HttpError(404, `no identity ${identity}`);
    const shift = await hq.shifts.request(identity, { reason: 'manual', forceNew: b.new === true });
    if (typeof b.prompt === 'string' && b.prompt) hq.mailbox.tell({ to: identity, body: b.prompt, msg_id: str(b.msg_id, 'msg_id', false) });
    return { shift };
  });
  route('POST', '/api/shifts/:id/stop', async ({ params, body }) => {
    const b = await body();
    const id = decodeURIComponent(params[0]!);
    if (!hq.shifts.get(id)) throw new HttpError(404, `no shift ${id}`);
    await hq.shifts.stop(id, str(b.reason, 'reason', false) ?? 'owner_stop');
    return { shift: hq.shifts.get(id) };
  });
  route('POST', '/api/shifts/:id/interrupt', async ({ params }) => {
    await hq.shifts.interrupt(decodeURIComponent(params[0]!));
    return { ok: true };
  });

  route('GET', '/api/tasks', () => ({ tasks: hq.scheduler.tasks(), queue: hq.scheduler.queue().map((t) => ({ id: t.id, bucket: t.bucket })) }));
  route('POST', '/api/tasks', async ({ body }) => {
    const b = await body();
    return { task: hq.scheduler.addTask({
      title: str(b.title, 'title')!, ref: str(b.ref, 'ref', false), project: str(b.project, 'project', false), body: str(b.body, 'body', false),
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined, priority: typeof b.priority === 'number' ? b.priority : undefined,
      worktree: str(b.worktree, 'worktree', false), identity: str(b.identity, 'identity', false),
    }) };
  });

  // B.5 plumbing check with no worker: create + inspect + close a worktree in the project's checkout.
  route('POST', '/api/projects/:p/worktree-dry-run', async ({ params }) => {
    try { return { dryRun: await hq.scheduler.dryRunWorktree(decodeURIComponent(params[0]!)) }; }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  });

  // Priority (p0..p3, B.16 queue order) without editing hq.db by hand.
  route('PATCH', '/api/tasks/:id', async ({ params, body }) => {
    const b = await body();
    if (!Number.isInteger(b.priority) || (b.priority as number) < 0 || (b.priority as number) > 3) throw new HttpError(400, 'priority must be an integer 0..3');
    const t = hq.scheduler.setTaskPriority(Number(params[0]), b.priority as number);
    if (!t) throw new HttpError(404, `no task ${params[0]}`);
    return { task: t };
  });

  route('POST', '/api/tasks/:id/done', async ({ params }) => {
    const t = await hq.scheduler.completeTask(Number(params[0]));
    if (!t) throw new HttpError(404, `no task ${params[0]}`);
    return { task: t };
  });

  // "בדקתי" (#108): off "מה לבדוק", whichever it waited for.
  route('POST', '/api/tasks/:id/checked', ({ params }) => {
    const id = Number(params[0]);
    if (!hq.scheduler.task(id)) throw new HttpError(404, `no task ${params[0]}`);
    return { ok: hq.awaiting.clear(id, OWNER, 'checked'), task: hq.scheduler.task(id) };
  });

  // A deploy reports what it put in production (scripts/deploy.sh; any project's deploy may call it): the
  // tasks it includes leave "מה לבדוק" if they waited for a deploy. By task id, or by PR number in the project.
  route('POST', '/api/deploys', async ({ body }) => {
    const b = await body();
    const tasks = b.tasks == null ? [] : b.tasks;
    if (!Array.isArray(tasks) || tasks.some((t) => !Number.isInteger(t))) throw new HttpError(400, 'tasks must be an array of task ids');
    const prs = b.prs == null ? [] : b.prs;
    if (!Array.isArray(prs) || prs.some((p) => typeof p !== 'string' && !Number.isInteger(p))) throw new HttpError(400, 'prs must be an array of PR numbers');
    return { deploy: hq.awaiting.deployed({ project: str(b.project, 'project')!, sha: str(b.sha, 'sha')!, target: str(b.target, 'target', false),
      tasks: tasks as number[], prs: (prs as (string | number)[]).map(String) }) };
  });

  // Night mode (B.16): the same as writing "לילה" / the first message in the morning, for the app.
  route('GET', '/api/night', () => {
    const last = hq.night.last();
    return { night: hq.night.current() ?? null, last: last ? { ...last, summary: last.summary ? JSON.parse(last.summary) as unknown : null } : null };
  });
  route('POST', '/api/night/start', async ({ body }) => {
    const b = await body();
    return { night: await hq.night.start({ scope: Array.isArray(b.scope) ? b.scope.map(String) : null, note: str(b.note, 'note', false) ?? null,
      until: typeof b.until === 'number' ? b.until : null, by: OWNER }) };
  });
  route('POST', '/api/night/end', () => ({ summary: hq.night.end('owner') ?? null }));

  route('GET', '/api/toggles', () => ({ toggles: hq.store.toggles() }));
  route('PUT', '/api/toggles/:key', async ({ params, body }) => {
    const b = await body();
    if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
    const key = decodeURIComponent(params[0]!);
    if (!hq.store.toggles().some((t) => t.key === key)) throw new HttpError(404, `no toggle ${key}`);
    hq.store.setToggle(key, b.enabled, true);
    return { toggles: hq.store.toggles() };
  });

  route('GET', '/api/events', ({ url }) => ({
    events: hq.store.eventsAfter(Number(url.searchParams.get('after') ?? 0), Math.min(2000, Number(url.searchParams.get('limit') ?? 500)),
      url.searchParams.get('identity') ?? undefined),
  }));

  route('GET', '/api/push/vapid', () => ({ publicKey: hq.pusher.publicKey }));
  route('POST', '/api/push/subscribe', async ({ body }) => {
    const b = await body();
    try { hq.pusher.subscribe(b as never); } catch (e) { throw new HttpError(400, (e as Error).message); }
    return { ok: true };
  });

  // B.7 accounts: the view, "כולם ל-X" (name null = automatic), guided login, identity check, quota now.
  route('GET', '/api/accounts', () => hq.accounts.view());
  route('PUT', '/api/accounts/pinned', async ({ body }) => {
    const b = await body();
    try { hq.accounts.setPinned(b.name == null || b.name === '' ? null : str(b.name, 'name')!); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
    return hq.accounts.view();
  });
  route('POST', '/api/accounts/:name/login', async ({ params }) => {
    try { return await hq.accounts.startLogin(decodeURIComponent(params[0]!)); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  });
  route('POST', '/api/accounts/:name/verify', async ({ params }) => {
    if (!hq.accounts.get(decodeURIComponent(params[0]!))) throw new HttpError(404, 'no such account');
    return { account: await hq.accounts.verify(decodeURIComponent(params[0]!)) };
  });
  route('POST', '/api/accounts/refresh', async () => { await hq.accounts.refresh(); return hq.accounts.view(); });

  // Devices and passkeys (settings → devices). The caller's own device is marked `current`.
  // The in-app update (app-release.ts): the newest APK deploy put out, or null.
  route('GET', '/api/app/latest', () => ({ latest: hq.appReleases.latest()?.release ?? null }));

  route('GET', '/api/devices', ({ caller }) => {
    const d = hq.auth.devices();
    return { ...d, devices: d.devices.map((x) => ({ ...x, current: caller.kind === 'device' && caller.id === x.id })) };
  });
  route('POST', '/api/devices/pair', ({ caller }) => hq.auth.createPairCode(caller));
  route('POST', '/api/devices/:id/revoke', ({ params }) => ({ device: hq.auth.revokeDevice(decodeURIComponent(params[0]!)) }));
  route('POST', '/api/passkeys/:id/revoke', ({ params }) => hq.auth.revokePasskey(decodeURIComponent(params[0]!)));

  return r;
}

/**
 * Who is asking, for counting wrong pairing codes. hq listens on loopback behind Caddy, which sets
 * X-Forwarded-For to the client it saw (the last entry); direct local callers count by socket.
 */
function clientAddress(req: IncomingMessage): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) ?? req.socket.remoteAddress ?? 'local';
}

/** Open routes: how a device gets its token. Everything here proves itself (passkey or one-time code). */
export function buildAuthRoutes(hq: Hq): [string, RegExp, Handler][] {
  const r: [string, RegExp, Handler][] = [];
  const route = (path: string, h: Handler) => r.push(['POST', new RegExp(`^${path}$`), h]);
  route('/api/auth/login/options', () => hq.auth.loginOptions());
  route('/api/auth/login', async ({ body }) => { const b = await body(); return hq.auth.login(b.credential, deviceName(b.name)); });
  route('/api/auth/register/options', async ({ req, body }) => hq.auth.registerOptions((await body()).code, clientAddress(req)));
  route('/api/auth/register', async ({ req, body }) => { const b = await body(); return hq.auth.register(b.credential, deviceName(b.name), clientAddress(req)); });
  route('/api/auth/pair', async ({ req, body }) => { const b = await body(); return hq.auth.pair(b.code, deviceName(b.name), clientAddress(req)); });
  return r;
}

export interface ApiServer { server: Server; wss: WebSocketServer; port: number; close(): Promise<void> }

export async function startApi(hq: Hq, token: string, host: string, port: number): Promise<ApiServer> {
  const routes = buildRoutes(hq);
  const authRoutes = buildAuthRoutes(hq);
  const json = (res: ServerResponse, status: number, v: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(v));
  };
  const who = (given: string | null | undefined): Caller | null =>
    tokenOk(given, token) ? { kind: 'admin' } : hq.auth.deviceFor(given);
  // Bearer header for HTTP. `?token=` only on the WS upgrade (browsers can't set headers there), so the
  // token doesn't end up in proxy logs for ordinary requests.
  const caller = (req: IncomingMessage, url: URL, allowQuery = false): Caller | null => {
    const h = req.headers.authorization;
    return who(h?.startsWith('Bearer ') ? h.slice(7) : (allowQuery ? url.searchParams.get('token') : null));
  };
  const dispatch = async (table: [string, RegExp, Handler][], req: IncomingMessage, res: ServerResponse, url: URL, c: Caller | null) => {
    for (const [m, re, h] of table) {
      if (m !== req.method) continue;
      const match = re.exec(url.pathname);
      if (!match) continue;
      json(res, 200, await h({ req, url, params: match.slice(1), body: () => readBody(req), caller: c! }));
      return true;
    }
    return false;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hq');
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        const h = health(hq);
        return json(res, h.ok ? 200 : 503, h);
      }
      if (url.pathname.startsWith('/api/auth/')) {
        if (await dispatch(authRoutes, req, res, url, null)) return;
        return json(res, 404, { error: 'not found' });
      }
      const c = caller(req, url);
      if (!c) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST' && url.pathname === '/api/dictate/transcribe') return await proxyDictate(hq.cfg.dictate, req, res);
      // Attached images (uploads.ts): raw bytes in, raw bytes out, so these two skip the JSON routes.
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const name = req.headers['x-file-name'];
        let file: string | undefined;
        try { file = typeof name === 'string' ? decodeURIComponent(name) : undefined; } catch { throw new HttpError(400, 'x-file-name must be URI-encoded'); }
        return json(res, 200, { upload: hq.uploads.save(await readRaw(req), file) });
      }
      const up = req.method === 'GET' ? /^\/api\/uploads\/([^/]+)$/.exec(url.pathname) : null;
      if (up) {
        const f = hq.uploads.read(decodeURIComponent(up[1]!));
        if (!f) return json(res, 404, { error: 'no such upload' });
        // An upload never changes: the app may keep it as long as it likes, but only on this device.
        res.writeHead(200, { 'content-type': f.upload.mime, 'content-length': f.data.length, 'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff' });
        return res.end(f.data);
      }
      const apk = req.method === 'GET' ? /^\/api\/app\/apk\/(\d+)$/.exec(url.pathname) : null;
      if (apk) {
        const r = hq.appReleases.apk(Number(apk[1]));
        if (!r) return json(res, 404, { error: 'no such version' });
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': r.release.bytes,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const s = createReadStream(r.file);
        s.on('error', () => res.destroy());
        return void s.pipe(res);
      }
      if (await hq.ingest.handle(req, res, () => readBody(req))) return;
      if (await dispatch(routes, req, res, url, c)) return;
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof HttpError || e instanceof AuthError || e instanceof UploadError ? e.status : /required|invalid|must be/.test((e as Error).message) ? 400 : 500;
      return json(res, status, { error: (e as Error).message });
    }
  });

  // WS /ws?after=<seq>&identity=<id>: replays events after seq, then streams live (B.8 "resume from the last seq").
  const wss = new WebSocketServer({ noServer: true });
  // A revoked device loses its live stream at once, not on its next request.
  const deviceSockets = new Map<string, Set<WebSocket>>();
  const offRevoke = hq.auth.onRevoke((ids) => {
    for (const id of ids) for (const ws of deviceSockets.get(id) ?? []) ws.close(4401, 'device revoked');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://hq');
    const protoToken = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).find((p) => p.startsWith('token.'))?.slice(6);
    const c = url.pathname === '/ws' ? (caller(req, url, true) ?? who(protoToken)) : null;
    if (!c) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (c.kind === 'device') {
        const set = deviceSockets.get(c.id) ?? new Set<WebSocket>();
        deviceSockets.set(c.id, set.add(ws));
        ws.on('close', () => { set.delete(ws); if (!set.size) deviceSockets.delete(c.id); });
      }
      streamEvents(hq, ws, url);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  return {
    server, wss, port: typeof addr === 'object' && addr ? addr.port : port,
    close: () => new Promise((resolve) => {
      offRevoke();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function lastSeq(hq: Hq): number {
  return (hq.store.db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM events').get() as { s: number }).s;
}

function streamEvents(hq: Hq, ws: WebSocket, url: URL): void {
  const identity = url.searchParams.get('identity') ?? undefined;
  let cursor = Number(url.searchParams.get('after') ?? 0);
  // A fresh client (no cursor) gets the recent tail only; older history is paged over REST /api/events.
  if (!url.searchParams.has('after')) cursor = Math.max(0, lastSeq(hq) - 1000);
  const buffered: unknown[] = [];
  let replaying = true;
  const off = hq.store.onEvent((e) => {
    if (identity && e.identity !== identity) return;
    if (e.seq === 0) { if (!replaying) ws.send(JSON.stringify(e)); return; } // live-only (deltas)
    if (replaying) buffered.push(e);
    else if (e.seq > cursor) { cursor = e.seq; ws.send(JSON.stringify(e)); }
  });
  ws.on('close', off);
  ws.on('error', off);
  // Replay from the log, then hand over to the live listener without gaps or duplicates.
  for (;;) {
    const batch = hq.store.eventsAfter(cursor, 1000, identity);
    for (const e of batch) { ws.send(JSON.stringify(e)); cursor = e.seq; }
    if (batch.length < 1000) break;
  }
  replaying = false;
  for (const e of buffered as { seq: number }[]) if (e.seq > cursor) { cursor = e.seq; ws.send(JSON.stringify(e)); }
  ws.send(JSON.stringify({ type: 'live', seq: cursor }));
}
