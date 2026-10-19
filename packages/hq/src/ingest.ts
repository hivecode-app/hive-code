// Server side of the mcp-company / hooks ingest API (packages/shared/src/company-api.ts, engine lane).
//   POST /v1/ops     WalEntry → OpAck   (idempotent on entry.id; 4xx = permanent reject, 5xx = retry)
//   POST /v1/recall  RecallRequest → RecallResponse
// Served on the unix socket <state>/hq.sock (0600, no token: filesystem permissions are the auth) and
// on the TCP API behind the token. Every op is stored first (ops table), then applied.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, lstatSync, chmodSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  COMPANY_API_VERSION, OWNER, type OpAck, type OpName, type Priority, type RecallItem, type RecallRequest, type RecallResponse,
  type Urgency, type WalEntry,
} from '@company/shared';
import type { Hq } from './hq.ts';

const OPS: ReadonlySet<OpName> = new Set(['tell', 'ask', 'remember', 'handoff', 'status', 'open_team', 'close_team', 'request_go', 'open_ticket']);

export class IngestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Opens a GitHub issue for open_ticket. Injected in tests; default is the gh CLI. */
export type Ticketer = (repo: string, title: string, body: string, labels: string[]) => Promise<string>;

export const ghTicketer: Ticketer = (repo, title, body, labels) => new Promise((resolve, reject) => {
  const args = ['issue', 'create', '-R', repo, '--title', title, '--body', body, ...labels.flatMap((l) => ['--label', l])];
  execFile('gh', args, { timeout: 60_000 }, (err, out, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(0, 300))) : resolve(out.trim())));
});

export class Ingest {
  private hq: Hq;
  ticketer: Ticketer;

  constructor(hq: Hq, ticketer: Ticketer = ghTicketer) {
    this.hq = hq;
    this.ticketer = ticketer;
  }

  /** Validate, store, apply. A replayed id returns the stored ack without applying again. */
  op(raw: unknown): OpAck {
    const e = raw as Partial<WalEntry>;
    if (!e || typeof e !== 'object') throw new IngestError(400, 'body must be a WalEntry');
    if (e.v !== COMPANY_API_VERSION) throw new IngestError(400, `unsupported version ${String(e.v)}`);
    if (!s(e.id) || !s(e.identity) || !s(e.op)) throw new IngestError(400, 'id, identity and op are required');
    if (!OPS.has(e.op as OpName)) throw new IngestError(400, `unknown op ${String(e.op)}`);
    if (!this.hq.identityExists(e.identity!)) throw new IngestError(400, `unknown identity ${String(e.identity)}`);
    const args = (e.args && typeof e.args === 'object' ? e.args : {}) as Record<string, unknown>;
    const db = this.hq.store.db;
    const prev = db.prepare('SELECT ack FROM ops WHERE id = ?').get(e.id) as { ack: string } | undefined;
    if (prev) return JSON.parse(prev.ack) as OpAck;

    const ack = db.transaction((): OpAck => {
      const a = this.apply(e as WalEntry, args);
      db.prepare(`INSERT INTO ops (id, identity, shift, session_id, op, args, ts, received_at, ack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, e.identity, e.shift ?? null, e.sessionId ?? null, e.op, JSON.stringify(args), e.ts ?? null, this.hq.store.now(), JSON.stringify(a));
      return a;
    })();
    this.hq.store.emit(`op.${e.op}`, e.identity!, { id: e.id, shift: e.shift ?? null, args });
    if (e.op === 'open_ticket') this.hq.store.bg(this.openTicket(e as WalEntry, args), 'open_ticket');
    return ack;
  }

  private apply(e: WalEntry, a: Record<string, unknown>): OpAck {
    const { mailbox, inbox } = this.hq;
    const need = (k: string) => { const v = s(a[k]); if (!v) throw new IngestError(400, `${e.op}: ${k} is required`); return v; };
    switch (e.op) {
      case 'tell': {
        // mcp-company's `urgency` is the delivery priority (now|next|later); map it onto both axes.
        const pr = (['now', 'next', 'later'] as const).includes(a.urgency as Priority) ? (a.urgency as Priority) : 'next';
        const urgency: Urgency = pr === 'now' ? 'urgent' : pr === 'later' ? 'low' : 'normal';
        const to = need('to');
        // A display name ("יואב") instead of an id would wake a shift for an identity that doesn't exist.
        if (to !== OWNER && to !== 'hq' && !this.hq.identityExists(to)) {
          const why = `tell: unknown identity ${to} (use the id, e.g. yoav, or ${OWNER} for רן)`;
          // MCP writes are acked locally ({queued:true}), so a 400 alone never reaches the worker. Tell it,
          // after this transaction rolls back.
          queueMicrotask(() => {
            try {
              mailbox.tell({ msg_id: `${e.id}-rejected`, from: 'hq', to: e.identity, kind: 'system', priority: 'now', ref: e.id,
                body: `ההודעה שלך ל-"${to}" לא נשלחה: אין identity כזה. שלח שוב עם ה-id (מה שבסוגריים בכותרת ההודעה), למשל yoav, או ${OWNER} לרן.` });
            } catch { /* best effort */ }
          });
          throw new IngestError(400, why);
        }
        const m = mailbox.tell({ msg_id: e.id, from: e.identity, to, body: need('body'), priority: pr, urgency, ref: s(a.ref) });
        return { ok: true, id: e.id, ref: m.id };
      }
      case 'ask': {
        const ask = mailbox.ask({ msg_id: e.id, from: e.identity, question: need('question'), options: strList(a.options), blocking: a.blocking === true });
        return { ok: true, id: e.id, ref: ask.id };
      }
      case 'request_go': {
        const what = need('what');
        const item = inbox.add({ kind: 'go', from_identity: e.identity, title: `GO: ${what}`.slice(0, 200), blocking: true,
          urgency: a.risk === 'high' ? 'urgent' : 'normal', ref: e.id, dedupe_key: `op:${e.id}`,
          body: [what, s(a.pr) ? `PR: ${String(a.pr)}` : '', s(a.risk) ? `סיכון: ${String(a.risk)}` : ''].filter(Boolean).join('\n') });
        return { ok: true, id: e.id, ref: `inbox-${item.id}` };
      }
      case 'open_ticket':
        need('repo'); need('title');
        return { ok: true, id: e.id, result: { queued: true } };
      case 'status': {
        // status{state: done} from a task worker closes its task (ends the shift with task_done).
        if (a.state === 'done' || a.state === 'task_done') {
          const t = this.hq.store.db.prepare(`SELECT id FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
            .get(e.identity) as { id: number } | undefined;
          if (t) this.hq.store.bg(this.hq.scheduler.completeTask(t.id), 'task.complete');
          return { ok: true, id: e.id, result: { stored: true, task_done: t?.id ?? null } };
        }
        return { ok: true, id: e.id, result: { stored: true } };
      }
      case 'open_team': {
        // Phase 1: a team opened by a worker is a task team = a task in the scheduler queue (B.16). The
        // opener is who the worker reports to (labels opened-by:<id>). Deduped on ref (e.g. an issue).
        const db = this.hq.store.db;
        const own = (db.prepare('SELECT project FROM identities WHERE id = ?').get(e.identity) as { project: string | null } | undefined)?.project;
        const project = s(a.project) ?? own ?? undefined;
        // 4xx, not a thrown 500: the WAL retries 5xx at its head forever and would hold back every later op.
        if (project != null && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)
          || (!existsSync(join(this.hq.cfg.companyDir, 'projects', `${project}.md`)) && !db.prepare('SELECT 1 FROM identities WHERE project = ?').get(project)))) {
          throw new IngestError(400, `open_team: unknown project ${project}`);
        }
        // Same ticket while its task is still open → that task. A finished one is not reopened silently.
        const base = s(a.ref) ?? `team:${e.id}`;
        const open = db.prepare(`SELECT ref FROM tasks WHERE (ref = ? OR ref LIKE ? ESCAPE '\\') AND state != 'done' ORDER BY id DESC LIMIT 1`)
          .get(base, `${base.replace(/[\\%_]/g, (c) => `\\${c}`)} · %`) as { ref: string } | undefined;
        const taken = !open && db.prepare('SELECT 1 FROM tasks WHERE ref = ?').get(base);
        const ref = open?.ref ?? (taken ? `${base} · ${e.id}` : base);
        const task = this.hq.scheduler.addTask({
          title: need('name'), body: need('purpose'), project, ref, labels: [`opened-by:${e.identity}`],
        });
        return { ok: true, id: e.id, ref: `task-${task.id}`, result: { task: task.id, state: task.state } };
      }
      default:
        // remember / handoff / status / close_team: stored durably now (ops table),
        // consumed by memory consolidation, prime.json (handoff) and the board.
        return { ok: true, id: e.id, result: { stored: true } };
    }
  }

  /** open_ticket runs after its ack is stored; tickets acked before a crash but never opened are opened now. */
  async drainPendingTickets(): Promise<number> {
    const rows = this.hq.store.db.prepare(`SELECT * FROM ops o WHERE op = 'open_ticket' AND NOT EXISTS
      (SELECT 1 FROM messages m WHERE m.id IN (o.id || '-ticket', o.id || '-ticket-failed'))`).all() as
      { id: string; identity: string; shift: string | null; session_id: string | null; args: string; ts: string | null }[];
    for (const r of rows) {
      await this.openTicket({ id: r.id, v: 1, ts: r.ts ?? '', identity: r.identity, shift: r.shift ?? '', sessionId: r.session_id, op: 'open_ticket', args: {} },
        JSON.parse(r.args) as Record<string, unknown>);
    }
    return rows.length;
  }

  private inflightTickets = new Set<string>();

  private async openTicket(e: WalEntry, a: Record<string, unknown>): Promise<void> {
    if (this.inflightTickets.has(e.id)) return;
    this.inflightTickets.add(e.id);
    try { await this.openTicketOnce(e, a); } finally { this.inflightTickets.delete(e.id); }
  }

  private async openTicketOnce(e: WalEntry, a: Record<string, unknown>): Promise<void> {
    const repo = String(a.repo), title = String(a.title);
    try {
      const url = await this.ticketer(repo, title, String(a.body ?? ''), strList(a.labels));
      this.hq.mailbox.tell({ msg_id: `${e.id}-ticket`, from: 'hq', to: e.identity, kind: 'system', ref: e.id, body: `נפתח טיקט: ${url}` });
    } catch (err) {
      this.hq.mailbox.tell({ msg_id: `${e.id}-ticket-failed`, from: 'hq', to: e.identity, kind: 'system', ref: e.id, priority: 'now',
        body: `פתיחת הטיקט "${title}" ב-${repo} נכשלה: ${(err as Error).message}` });
    }
  }

  /** Phase 1 recall: term match over memory/ in the company repo + stored remember/handoff ops. */
  recall(raw: unknown): RecallResponse {
    const r = raw as Partial<RecallRequest>;
    if (!r || !s(r.query)) throw new IngestError(400, 'query is required');
    const terms = r.query!.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const limit = Math.min(50, Math.max(1, Number(r.limit ?? 8)));
    const items: RecallItem[] = [];
    const score = (text: string) => { const l = text.toLowerCase(); return terms.reduce((n, t) => n + (l.includes(t) ? 1 : 0), 0); };
    const scope = r.scope ?? '';
    const memDir = join(this.hq.cfg.companyDir, '..', 'memory');
    for (const file of walk(memDir)) {
      const rel = relative(join(memDir, '..'), file);
      if (scope.startsWith('project:') && !rel.includes(`projects/${scope.slice(8)}`)) continue;
      if (scope.startsWith('personal:') && !rel.includes(`personal/${scope.slice(9)}`)) continue;
      const text = readFileSync(file, 'utf8');
      const sc = score(text);
      if (!sc) continue;
      const line = text.split('\n').find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? text.slice(0, 200);
      items.push({ ref: rel, scope: rel.split('/')[1] ?? 'company', title: text.match(/^#\s+(.+)$/m)?.[1], text: line.slice(0, 400), score: sc });
    }
    const ops = this.hq.store.db.prepare(`SELECT id, identity, op, args FROM ops WHERE op IN ('remember','handoff') ORDER BY received_at DESC LIMIT 2000`).all() as
      { id: string; identity: string; op: string; args: string }[];
    for (const o of ops) {
      const sc = score(o.args);
      if (sc) items.push({ ref: o.id, scope: o.op === 'handoff' ? 'archive' : 'store', title: `${o.op} · ${o.identity}`, text: o.args.slice(0, 400), score: sc });
    }
    items.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    return { items: items.slice(0, limit) };
  }

  /** For prime.json: the top record's full body (bet 9) plus the next refs as an index. */
  primeRecall(identity: string, query: string): { top?: { ref: string; body: string }; others: string[] } {
    const project = (this.hq.store.db.prepare('SELECT project FROM identities WHERE id = ?').get(identity) as { project: string | null } | undefined)?.project;
    let { items } = this.recall({ identity, shift: '', query, limit: 8 });
    if (project) items = [...items.filter((i) => i.ref.includes(`projects/${project}/`)), ...items.filter((i) => !i.ref.includes(`projects/${project}/`))];
    if (!items.length) return { others: [] };
    const [first, ...rest] = items;
    const memRoot = join(this.hq.cfg.companyDir, '..');
    const body = first!.ref.startsWith('memory/') ? readFileSync(join(memRoot, first!.ref), 'utf8') : first!.text;
    return { top: { ref: first!.ref, body }, others: rest.map((i) => i.ref) };
  }

  /** Route a request; returns false if the path is not ours. */
  async handle(req: IncomingMessage, res: ServerResponse, readBody: () => Promise<unknown>): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://hq').pathname;
    if (req.method !== 'POST' || (path !== '/v1/ops' && path !== '/v1/recall')) return false;
    let status = 200, out: unknown;
    try {
      const body = await readBody();
      out = path === '/v1/ops' ? this.op(body) : this.recall(body);
    } catch (e) {
      status = e instanceof IngestError ? e.status : (e as { status?: number }).status ?? 500;
      out = { ok: false, error: (e as Error).message };
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    return true;
  }
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = lstatSync(p); // never follow symlinks (no cycles, no escaping memory/)
    if (st.isDirectory()) yield* walk(p);
    else if (f.endsWith('.md') && st.size < 512 * 1024) yield p;
  }
}

export function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new IngestError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new IngestError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** The local ingest socket: `<state>/hq.sock`, mode 0600. */
export async function startIngestSocket(ingest: Ingest, path: string): Promise<Server> {
  if (existsSync(path)) rmSync(path, { force: true }); // stale socket from a previous run
  const srv = createServer(async (req, res) => {
    if (!(await ingest.handle(req, res, () => readJson(req)))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
  });
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(path, () => resolve()); });
  chmodSync(path, 0o600);
  return srv;
}
