import { search } from './search.ts';
import { productPreferences } from './i18n.ts';
// HTTP + WebSocket API on 127.0.0.1 (B.8). Token auth on everything except GET /health (heartbeat), the
// pairing page GET /pair and GET /.well-known/assetlinks.json (pairing.ts), and
// /api/auth/* (getting a device token: passkey or pairing code, auth.ts). A token is either hq's own
// api-token (stays on the server) or a device token. The app uses this through Caddy; mcp-company and
// hooks use it for writes (idempotent by msg_id). POST /api/dictate/transcribe streams to dictate-server (dictate.ts).
// GET /api/app/latest and /api/app/apk/:code: the in-app update of the Android app (app-release.ts).
import { ETA_KINDS } from './estimates.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Hq } from './hq.ts';
import type { AwaitingOutcome } from './awaiting.ts';
import { AuthError, type Caller } from './auth.ts';
import { proxyDictate } from './dictate.ts';
import { MUTE_FOR } from './conversations.ts';
import { readRaw, UPLOAD_PART_BYTES, toDTO, UploadError } from './uploads.ts';
import { OWNER } from '@company/shared';
import { HomeError } from './home.ts';
import { assetLinks, pairPage } from './pairing.ts';
import { guarded, guardedUpgrade, rejectUpgrade, requestUrl } from './http-guard.ts';
import { normalizePath } from './error-watch.ts';
import { companyDay, dateOf, isDate, messageBody } from './company-day.ts';
import { recordPrMerged } from './merged.ts';
import { isCancelled, type TaskRow } from './scheduler.ts';
import { replyTimes, replyTimesByWorker } from './reply-times.ts';

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
/** POST /api/client-errors: at most this many per device in CLIENT_ERRORS_PER_MS. */
export const CLIENT_ERRORS_MAX = 30;
const CLIENT_ERRORS_PER_MS = 60_000;

/** The app shows `done` as finished by us and hides `closed` ("nobody works on it"): a task cancelled before it started goes out as the latter. */
export function forApp(tasks: TaskRow[]): TaskRow[] {
  return tasks.map((t) => (t.state === 'done' && isCancelled(t) ? { ...t, state: 'closed' } : t));
}

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

  // timezone: org.yaml's (#121), so the app shows his hours wherever the phone thinks it is.
  route('GET', '/api/search', ({ url }) => search(hq, url.searchParams.get('q') ?? ''));
  route('GET', '/api/org', () => ({ identities: hq.board(), teams: hq.teams(), timezone: hq.clock() }));
  // awaiting: "מה לבדוק" (#108), finished tasks that wait for a deploy or for him to check (awaiting.ts).
  // asked: "ביקשת" (#118), his requests to workers still waiting for an answer, and answers he hasn't read (asked.ts).
  // names: the owner's and the manager's, from org.yaml; the app builds and reads hq's texts by them (names.ts).
  // open_tasks: "בעבודה ובתור" (#128), every task not done, queued ones too, with its opener, worker, state and place in line.
  route('GET', '/api/board', () => {
    const identities = hq.board();
    return { identities, tasks: forApp(hq.scheduler.tasks()), open_tasks: hq.openTasks(identities), awaiting: hq.awaiting.list(), asked: hq.home.asked(),
      projects: hq.projects(), slots: { ...hq.scheduler.slots(), nodes: hq.scheduler.nodeSlots() }, probes: hq.probes.summary(), timezone: hq.clock(), manager: hq.cfg.managerId,
      names: hq.mailbox.names, ...productPreferences(hq.cfg.companyDir) };
  });

  // The head of the conversations screen (home.ts): the recipe in force, and a new one. The app says
  // ?opened=1 when he opens it (start, back to the front): a new visit, for "מאז שהיית פה". ?looking=1 from the
  // minute's reload while it is in front keeps the visit going; a reload on an event says neither.
  route('GET', '/api/home', ({ caller, url }) => {
    const p = url.searchParams;
    if (caller.kind === 'device' && (p.get('opened') === '1' || p.get('looking') === '1')) hq.home.seen(p.get('opened') === '1');
    return hq.home.current();
  });
  // From a device it is his own arrangement; only hq's admin token may compose in someone else's name.
  route('PUT', '/api/home', async ({ body, caller }) => {
    const b = await body();
    const by = caller.kind === 'device' ? OWNER : str(b.composed_by, 'composed_by', false) ?? OWNER;
    if (!hq.home.mayCompose(by)) throw new HttpError(403, `${by} may not compose the home screen`);
    try { hq.home.compose(b.blocks, by, str(b.reason, 'reason', false)); }
    catch (e) { throw e instanceof HomeError ? new HttpError(400, e.message) : e; }
    return hq.home.current();
  });

  // task 986: what is his (a question, a GO, a sign-in), and apart the tasks to check, cards in their worker's conversation.
  route('GET', '/api/inbox', () => ({ items: hq.inbox.mine(), checks: hq.inbox.checks() }));
  // request_access (access.ts): what workers asked hq to run in their name, the last days (the log he reads, and the weekly count of `unfit`).
  // resources: what each machine holds, by project, and who waits for room (resources.ts).
  route('GET', '/api/resources', () => hq.resources.view());
  route('GET', '/api/access', ({ url }) => ({ requests: hq.access.list(Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7))) }));
  // error-catcher (error-watch.ts): an error the app showed him, or one it threw. One event; the watch groups them.
  const clientErrors = new Map<string, number[]>();
  route('POST', '/api/client-errors', async ({ body, caller }) => {
    const key = caller.kind === 'device' ? `device:${caller.id}` : caller.kind;
    const now = hq.store.now();
    const recent = (clientErrors.get(key) ?? []).filter((t) => now - t < CLIENT_ERRORS_PER_MS);
    if (recent.length >= CLIENT_ERRORS_MAX) throw new HttpError(429, 'too many client errors');
    recent.push(now);
    clientErrors.set(key, recent);
    const b = await body();
    const clip = (v: unknown, name: string, n: number, required = false) => str(v, name, required)?.slice(0, n);
    const ev = hq.store.emit('client.error', null, {
      kind: clip(b.kind, 'kind', 40) ?? 'error', message: clip(b.message, 'message', 1000, true), screen: clip(b.screen, 'screen', 80) ?? '',
      app_version: clip(b.app_version, 'app_version', 40) ?? '', stack: clip(b.stack, 'stack', 4000) ?? '', shown: b.shown === true,
    });
    return { ok: true, seq: ev.seq };
  });
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
  // Only a device (the app) is him (#208). hq's admin token is a worker or a script: it closes in the name it gives
  // in `from`, or as hq, and its words never reach the requester as his.
  const closer = (caller: Caller, b: Record<string, unknown>) => caller.kind === 'device' ? OWNER : (f => f && f !== OWNER ? f : 'hq')(str(b.from, 'from', false));
  // He finished it ("סיימתי") or declined: the requester hears it now, through its mailbox.
  route('POST', '/api/inbox/:id/done', async ({ params, body, caller }) => {
    const b = await body();
    // A tab handoff ends as one: the view is released, the link burnt, the requester woken (tab/handoffs.ts).
    if (await hq.tab.fromInbox(Number(params[0]), false, closer(caller, b))) return { item: hq.inbox.get(Number(params[0])), message: null };
    if (hq.inbox.get(Number(params[0]))?.kind === 'awaiting') return awaitingOutcome(Number(params[0]), 'done');
    try { return hq.mailbox.complete(Number(params[0]), { note: str(b.note, 'note', false), by: closer(caller, b) }); }
    catch (e) { throw new HttpError(404, (e as Error).message); }
  });
  // His own words on an open question or GO, typed in the conversation: the item closes with them.
  route('POST', '/api/inbox/:id/answer', async ({ params, body }) => {
    const b = await body();
    if (hq.inbox.get(Number(params[0]))?.kind === 'awaiting') throw new HttpError(409, 'a task card closes with done or failed');
    const answer = str(b.answer, 'answer', !hasFiles(b)) ?? '';
    try { return hq.mailbox.reply(Number(params[0]), answer, strings(b.attachments, 'attachments')); }
    catch (e) {
      const why = (e as Error).message;
      throw new HttpError(/no inbox item/.test(why) ? 404 : /already handled/.test(why) ? 409 : 400, why);
    }
  });
  // #219: "נכשל" on a finished task's card. No details here: he writes them in the conversation, if at all.
  route('POST', '/api/inbox/:id/failed', ({ params }) => awaitingOutcome(Number(params[0]), 'failed'));
  // #297: "לא רלוונטי": off the list without telling anyone it failed.
  route('POST', '/api/inbox/:id/irrelevant', ({ params }) => awaitingOutcome(Number(params[0]), 'irrelevant'));
  function awaitingOutcome(id: number, outcome: AwaitingOutcome) {
    const item = hq.inbox.get(id);
    if (!item || item.kind !== 'awaiting') throw new HttpError(404, `no awaiting inbox item ${id}`);
    if (item.state !== 'open') throw new HttpError(409, `inbox item ${id} is already handled`);
    return { task: hq.awaiting.outcome(id, outcome), item: hq.inbox.get(id) };
  }
  route('POST', '/api/inbox/:id/dismiss', async ({ params, body, caller }) => {
    const b = await body();
    if (hq.inbox.get(Number(params[0]))?.kind === 'awaiting') throw new HttpError(409, 'a task card closes with done or failed');
    if (await hq.tab.fromInbox(Number(params[0]), true, closer(caller, b))) return { item: hq.inbox.get(Number(params[0])), message: null };
    try { return hq.mailbox.complete(Number(params[0]), { note: str(b.note, 'note', false), declined: true, by: closer(caller, b) }); }
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
      attachments: strings(b.attachments, 'attachments'), chat: true,
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

  // Time estimates (estimates.ts): what workers promised and how it ended. Filters: project, identity, state
  // (open|missed|done|cancelled), kind, message_id, task, since/until (created_at, ms or ISO), limit, missed=1 (ever past
  // due, also closed late: each row has `missed` and `missed_at`).
  route('GET', '/api/estimates', ({ url }) => {
    const q = (k: string) => url.searchParams.get(k) || undefined;
    const when = (k: string): number | undefined => {
      const v = q(k);
      if (v === undefined) return undefined;
      const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(t)) throw new HttpError(400, `${k} must be ms or an ISO date`);
      return t;
    };
    const count = (k: string): number | undefined => {
      const v = q(k);
      if (v === undefined) return undefined;
      if (!/^\d+$/.test(v)) throw new HttpError(400, `${k} must be a number`);
      return Number(v);
    };
    const kind = oneOf(q('kind'), ETA_KINDS, 'kind');
    return { estimates: hq.estimates.list({ project: q('project'), identity: q('identity'), kind, message_id: q('message_id'), task: count('task'),
      state: oneOf(q('state'), ['open', 'missed', 'done', 'cancelled'] as const, 'state'), since: when('since'), until: when('until'), limit: count('limit'), missed: q('missed') === '1' || undefined }) };
  });

  // How long he waits per worker (reply-times.ts): from his message to the first word and to the reply, over `hours` (default 24).
  route('GET', '/api/reply-times', ({ url }) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    const identity = url.searchParams.get('identity');
    const times = replyTimes(hq.store, hq.store.now() - hours * 3600_000).filter((t) => !identity || t.identity === identity);
    return { hours, workers: replyTimesByWorker(times), messages: times.slice(0, 50) };
  });

  // The company map (company-day.ts): one day's lines and tables, without any message text; a line's text on its own.
  route('GET', '/api/company-day', ({ url }) => {
    const tz = hq.timeZone();
    const date = url.searchParams.get('date') ?? dateOf(hq.store.now(), tz);
    if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    return companyDay(hq.store, hq.cfg.companyDir, tz, date);
  });
  route('GET', '/api/company-day/messages/:id', ({ params }) => {
    let id: string;
    try { id = decodeURIComponent(params[0]!); } catch { throw new HttpError(400, 'bad message id'); }
    const m = messageBody(hq.store, id);
    if (!m) throw new HttpError(404, 'no such message');
    return m;
  });
  // A PR merged by someone hq's spool did not see (the owner, a backfill): the same `pr.merged` event, once per PR.
  route('POST', '/api/prs/merged', async ({ body }) => {
    const b = await body();
    const number = Number(b.number);
    if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'number must be a PR number');
    return { recorded: recordPrMerged(hq.store, { repo: str(b.repo, 'repo', false) ?? null, number, title: str(b.title, 'title', false) ?? null,
      project: str(b.project, 'project', false) ?? null, by: str(b.by, 'by', false) ?? null }) };
  });

  route('GET', '/api/tasks', () => ({ tasks: forApp(hq.scheduler.tasks()), queue: hq.scheduler.queue().map((t) => ({ id: t.id, bucket: t.bucket })) }));
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

  const HQ_LABELS = ['opened-by:', 'repo:', 'closing-at:'];
  // Priority (p0..p3, B.16 queue order) and labels (e.g. `needs-local`, task-235) without editing hq.db by hand.
  // `labels` are added and `remove_labels` removed; the rest of the task's labels stay as they are.
  route('PATCH', '/api/tasks/:id', async ({ params, body }) => {
    const b = await body();
    const id = Number(params[0]);
    const list = (v: unknown, name: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length === 0 || !v.every((l) => typeof l === 'string' && l.trim() !== '')) throw new HttpError(400, `${name} must be a non-empty array of non-empty strings`);
      // hq writes these itself (who opened it, which checkout, when it closes). `needs-local` (fallbackLocal) is hq's too,
      // but taking it off is a lead's call: the task may go back to the node. `company:night` is a lead's to set.
      const own = v.find((l: string) => HQ_LABELS.some((p) => l.trim().startsWith(p)));
      if (own) throw new HttpError(400, `${name}: ${own} is hq's own`);
      return v.map((l: string) => l.trim());
    };
    const add = list(b.labels, 'labels'), remove = list(b.remove_labels, 'remove_labels');
    if (b.priority === undefined && !add && !remove) throw new HttpError(400, 'nothing to change: priority, labels or remove_labels');
    if (b.priority !== undefined && (!Number.isInteger(b.priority) || (b.priority as number) < 0 || (b.priority as number) > 3)) throw new HttpError(400, 'priority must be an integer 0..3');
    if (!hq.scheduler.task(id)) throw new HttpError(404, `no task ${params[0]}`);
    if (add || remove) hq.scheduler.setTaskLabels(id, add ?? [], remove ?? [], typeof b.by === 'string' && b.by ? b.by : 'לא ידוע');
    const t = b.priority !== undefined ? hq.scheduler.setTaskPriority(id, b.priority as number) : hq.scheduler.task(id);
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

  // Merged PRs that wait for a deploy or a GO (awaiting=deploy, or a GO about them): scripts/drift-check.sh does not
  // call production behind main on their account a drift.
  route('GET', '/api/deploys/waiting', ({ url }) => hq.awaiting.waitingDeploy(url.searchParams.get('project') ?? 'agent-company'));

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
    if (key === 'codex/lean') {
      try { await hq.setCodexLean(b.enabled); }
      catch (e) { throw new HttpError(409, (e as Error).message); }
    } else hq.store.setToggle(key, b.enabled, true);
    return { toggles: hq.store.toggles() };
  });

  route('GET', '/api/events', ({ url }) => ({
    events: hq.store.eventsAfter(Number(url.searchParams.get('after') ?? 0), Math.min(2000, Number(url.searchParams.get('limit') ?? 500)),
      url.searchParams.get('identity') ?? undefined, url.searchParams.get('tail') === '1'),
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
      const done = hq.loopWatch.begin(`${req.method} ${url.pathname}`);
      try { json(res, 200, await h({ req, url, params: match.slice(1), body: () => readBody(req), caller: c! })); }
      finally { done(); }
      return true;
    }
    return false;
  };

  const server = createServer(guarded(async (req, res) => {
    const url = requestUrl(req);
    if (!url) return json(res, 400, { error: 'bad request path' });
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        const h = health(hq);
        return json(res, h.ok ? 200 : 503, h);
      }
      // The pairing link's page and the APK's key for this domain (pairing.ts): open, like /health.
      if (req.method === 'GET' && url.pathname === '/pair') {
        const { status, html } = pairPage(req, url, hq.cfg.auth.appUrl);
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/assetlinks.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
        return res.end(JSON.stringify(assetLinks(hq.cfg.auth.origins), null, 2));
      }
      if (url.pathname.startsWith('/api/auth/')) {
        if (await dispatch(authRoutes, req, res, url, null)) return;
        return json(res, 404, { error: 'not found' });
      }
      if (url.pathname.startsWith('/artifacts/')) {
        const match = /^\/artifacts\/(a-[a-f0-9]+)\/v(\d+)\/([^/]+)\/(.+)$/.exec(url.pathname);
        if (!match || req.method !== 'GET') return json(res, 403, { error: 'artifact token required' });
        let file:string;
        try {file=decodeURIComponent(match[4]!);} catch {return json(res,404,{error:'invalid artifact path'});}
        const content = hq.artifacts.content(match[1]!, Number(match[2]), match[3]!, file);
        res.writeHead(200, { 'content-type': content.mime, ...content.headers });
        const stream = createReadStream(content.path); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      const c = caller(req, url);
      if (!c) return json(res, 401, { error: 'unauthorized' });
      const artifactThumb = req.method === 'GET' ? /^\/api\/artifacts\/([^/]+)\/thumb$/.exec(url.pathname) : null;
      if (artifactThumb) {
        const path = hq.artifacts.get(artifactThumb[1]!)?.thumb;
        if (!path || !existsSync(path)) return json(res,404,{error:'no thumbnail'});
        res.writeHead(200,{'content-type':'image/jpeg','cache-control':'private, max-age=60'});
        const stream = createReadStream(path); stream.on('error',()=>res.destroy()); stream.pipe(res); return;
      }
      const artifactOpen = req.method === 'POST' ? /^\/api\/artifacts\/([^/]+)\/open$/.exec(url.pathname) : null;
      if (artifactOpen) {
        const body = await readBody(req);
        if (body.version != null && (!Number.isInteger(body.version) || Number(body.version) < 1)) throw new UploadError(400, 'invalid version');
        return json(res,200,hq.artifacts.open(artifactOpen[1]!, body.version as number | undefined));
      }
      const artifactKeep = req.method === 'POST' ? /^\/api\/artifacts\/([^/]+)\/keep$/.exec(url.pathname) : null;
      if (artifactKeep) { const body = await readBody(req); hq.artifacts.keep(artifactKeep[1]!, body.keep !== false); return json(res,200,{ok:true}); }
      if (req.method === 'POST' && url.pathname === '/api/dictate/transcribe') return await proxyDictate(hq.cfg.dictate, req, res);
      // Attached images (uploads.ts): raw bytes in, raw bytes out, so these two skip the JSON routes.
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        if (String(req.headers['content-type']).includes('application/json') && !req.headers['x-file-name']) {
          const body = await readBody(req) as { name?: string; bytes?: number };
          if (typeof body.name !== 'string' || typeof body.bytes !== 'number') throw new UploadError(400, 'name and bytes are required');
          return json(res, 200, { upload: hq.uploads.open(body.name, body.bytes) });
        }
        const name = req.headers['x-file-name'];
        let file: string | undefined;
        try { file = typeof name === 'string' ? decodeURIComponent(name) : undefined; } catch { throw new HttpError(400, 'x-file-name must be URI-encoded'); }
        const upload = hq.uploads.save(await readRaw(req), file);
        return json(res, 200, { upload });
      }
      const part = req.method === 'PUT' ? /^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(url.pathname) : null;
      if (part) return json(res, 200, { upload: hq.uploads.part(part[1]!, Number(part[2]), await readRaw(req, UPLOAD_PART_BYTES)) });
      const complete = req.method === 'POST' ? /^\/api\/uploads\/([^/]+)\/complete$/.exec(url.pathname) : null;
      if (complete) {
        const body = await readBody(req) as { sha256?: string };
        if (body.sha256 != null && !/^[a-f0-9]{64}$/i.test(body.sha256)) throw new UploadError(400, 'invalid sha256');
        return json(res, 200, { upload: await hq.uploads.complete(complete[1]!, body.sha256) });
      }
      const status = req.method === 'GET' ? /^\/api\/uploads\/([^/]+)\/status$/.exec(url.pathname) : null;
      if (status) return json(res, 200, { upload: hq.uploads.status(status[1]!) });
      const up = req.method === 'GET' ? /^\/api\/uploads\/([^/]+)(\/thumb)?$/.exec(url.pathname) : null;
      if (up) {
        const upload = hq.uploads.get(decodeURIComponent(up[1]!));
        if (!upload) return json(res, 404, { error: 'no such upload' });
        if (up[2]) await hq.uploads.prepare(upload.id);
        const path = up[2] ? hq.uploads.get(upload.id)?.meta?.thumb : upload.path;
        if (!path || !existsSync(path)) return json(res, 404, { error: 'no thumbnail' });
        const mime = up[2] ? 'image/jpeg' : upload.mime;
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff', ...(url.searchParams.has('download') || !mime.startsWith('image/') ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(upload.name)}` } : {}) });
        const stream = createReadStream(path); stream.on('error', () => res.destroy()); stream.pipe(res); return;
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
      const status = e instanceof HttpError || e instanceof AuthError || e instanceof UploadError ? e.status
        : e instanceof URIError || /required|invalid|must be/.test((e as Error).message) ? 400 : 500;
      if (status === 500) {
        console.error(`api: ${req.method} ${req.url} failed: ${(e as Error)?.stack ?? e}`);
        // error-watch.ts: a 5xx is an error he sees. The route without its ids, the first line of the stack.
        try {
          const stack = String((e as Error)?.stack ?? '').split('\n').slice(1).find((l) => l.trim())?.trim() ?? '';
          hq.store.emit('api.5xx', null, { method: req.method, route: normalizePath(req.url ?? ''), error: String((e as Error)?.message ?? e).slice(0, 500), stack });
        } catch { /* the answer goes out anyway */ }
      }
      if (res.headersSent) return void res.destroy();
      return json(res, status, { error: (e as Error).message });
    }
  }));

  // WS /ws?after=<seq>&identity=<id>: replays events after seq, then streams live (B.8 "resume from the last seq").
  const wss = new WebSocketServer({ noServer: true });
  // A revoked device loses its live stream at once, not on its next request.
  const deviceSockets = new Map<string, Set<WebSocket>>();
  const offRevoke = hq.auth.onRevoke((ids) => {
    for (const id of ids) for (const ws of deviceSockets.get(id) ?? []) ws.close(4401, 'device revoked');
  });
  server.on('upgrade', guardedUpgrade((req, socket, head) => {
    const url = requestUrl(req);
    if (!url) return rejectUpgrade(socket, 400, 'Bad Request');
    const protoToken = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).find((p) => p.startsWith('token.'))?.slice(6);
    const c = url.pathname === '/ws' ? (caller(req, url, true) ?? who(protoToken)) : null;
    if (!c) return rejectUpgrade(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        if (c.kind === 'device') {
          const set = deviceSockets.get(c.id) ?? new Set<WebSocket>();
          deviceSockets.set(c.id, set.add(ws));
          hq.auth.link(c.id, 1);
          ws.on('close', () => { set.delete(ws); if (!set.size) deviceSockets.delete(c.id); hq.auth.link(c.id, -1); });
        }
        streamEvents(hq, ws, url);
      } catch (e) {
        console.error(`api: ws ${req.url} failed: ${(e as Error)?.stack ?? e}`);
        ws.close(1011, 'internal error');
      }
    });
  }));

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

/** How often /ws says `{type:'ping'}` when nothing else is said (a test shortens it). */
export const wsPing = { ms: 20_000 };
const PING = JSON.stringify({ type: 'ping', seq: 0 });

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
  // A word every 20 s even when nothing happens: a phone whose socket died in its sleep (no close, no
  // error) has nothing to tell it so otherwise; the app replaces a link that stays silent (hq_backend.dart).
  // A protocol ping too: a socket that missed the last pong is dead, and is closed here, so a phone that went
  // away does not keep counting as "the app is connected" (push.ts sends Telegram only when it is not).
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const ping = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!alive) { ws.terminate(); return; }
    alive = false;
    ws.ping();
    ws.send(PING);
  }, wsPing.ms);
  ping.unref?.();
  const stop = (): void => { off(); clearInterval(ping); };
  ws.on('close', stop);
  ws.on('error', stop);
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
