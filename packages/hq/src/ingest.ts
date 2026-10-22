// Server side of the mcp-company / hooks ingest API (packages/shared/src/company-api.ts, engine lane).
//   POST /v1/ops     WalEntry → OpAck   (idempotent on entry.id; 4xx = permanent reject, 5xx = retry)
//   POST /v1/recall  RecallRequest → RecallResponse
//   POST /v1/resources {} → {text}: the machines' resources as short lines (resources.ts, read-only)
//   POST /v1/lease   {op: reserve|release|attach|beat|finish, …} → LeaseReply (leases.ts: a place for a heavy command)
//   POST /v1/access  {identity, shift, resource, argv, why?, wait?} | {identity, shift, request|cancel} → AccessReply (access.ts: hq runs it in the worker's name)
//   POST /v1/handoffs              {identity, target?, url?, what?, need?, ttl_min?} → {handoff, link, inbox_id} | 409 {busy}
//   GET  /v1/handoffs/<id>?wait=ms  long-poll until it ends (browser_ask_user's wake-up, B.9)
//   POST /v1/handoffs/<id>/end     {state: done|cancelled, final_url?}  (the worker's page watcher saw it done)
// Served on the unix socket <state>/hq.sock (0600, no token: filesystem permissions are the auth) and
// on the TCP API behind the token. Every op is stored first (ops table), then applied.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, lstatSync, chmodSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  COMPANY_API_VERSION, g, OWNER, pre, type OpAck, type OpName, type Priority, type RecallItem, type RecallRequest, type RecallResponse,
  type InboxLink, type Urgency, type WalEntry,
} from '@company/shared';
import type { Hq } from './hq.ts';
import { noWorkers, readCharter } from './workspace.ts';
import { getIdentity, isStandingWorker } from './org.ts';
import { prNumber } from './awaiting.ts';
import { HandoffError } from './tab/handoffs.ts';
import { HomeError } from './home.ts';
import { GoCloseError, waitingLine } from './mailbox.ts';
import { FILE_MODES, memoryFilePath } from './memory-files.ts';
import { blobSha, MAX_TEXT_BYTES, secretIn } from './memory-registry.ts';
import { guarded, requestUrl } from './http-guard.ts';
import { EstimateError, parseEta } from './estimates.ts';
import { AccessError } from './access.ts';
import { LeaseError } from './leases.ts';

const OPS: ReadonlySet<OpName> = new Set(['tell', 'ask', 'remember', 'handoff', 'status', 'open_team', 'close_team', 'request_go', 'open_ticket', 'compose_home', 'withdraw_ask', 'withdraw_go']);

export class IngestError extends Error {
  status: number;
  /** The reason in Hebrew, for the sender's mailbox when an op is rejected. */
  he?: string;
  constructor(status: number, message: string, he?: string) { super(message); this.status = status; this.he = he; }
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** Priority from a title like "p0: …", "P1 …" or "[p0] …" (after spaces or brackets). Only p0 and p1: the levels a lead writes to jump the queue. */
export const titlePriority = (title: string): number | undefined => {
  const m = /^[\s([{]*p([01])(?![0-9A-Za-z])/i.exec(title);
  return m ? Number(m[1]) : undefined;
};
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
    if (!s(e.id) || !s(e.identity) || !s(e.op)) throw new IngestError(400, 'id, identity and op are required');
    if (!this.hq.identityExists(e.identity!)) {
      // No mailbox to tell (e.g. org.yaml not reloaded yet), so at least the board sees it.
      const err = new IngestError(400, `unknown identity ${String(e.identity)}`);
      // Best effort: a failed event write must not turn this 400 into a 500 that the WAL retries at its head forever.
      try { this.hq.store.emit('op.rejected', null, { id: e.id, shift: e.shift ?? null, op: e.op, from: e.identity, status: err.status, error: err.message }); }
      catch { /* the 400 still reaches the sender's stderr log */ }
      throw err;
    }
    const reject = (err: IngestError): never => { this.rejected(e as WalEntry, err); throw err; };
    if (e.v !== COMPANY_API_VERSION) reject(new IngestError(400, `unsupported version ${String(e.v)}`, `גרסת API לא נתמכת (${String(e.v)})`));
    if (!OPS.has(e.op as OpName)) reject(new IngestError(400, `unknown op ${String(e.op)}`, 'אין פעולה כזו'));
    const args = (e.args && typeof e.args === 'object' ? e.args : {}) as Record<string, unknown>;
    const db = this.hq.store.db;
    const prev = db.prepare('SELECT ack FROM ops WHERE id = ?').get(e.id) as { ack: string } | undefined;
    if (prev) return JSON.parse(prev.ack) as OpAck;

    let ack: OpAck;
    try {
      ack = db.transaction((): OpAck => {
        const a = this.apply(e as WalEntry, args);
        db.prepare(`INSERT INTO ops (id, identity, shift, session_id, op, args, ts, received_at, ack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(e.id, e.identity, e.shift ?? null, e.sessionId ?? null, e.op, JSON.stringify(args), e.ts ?? null, this.hq.store.now(), JSON.stringify(a));
        return a;
      })();
    } catch (err) {
      if (err instanceof IngestError && err.status >= 400 && err.status < 500) reject(err);
      throw err;
    }
    this.hq.store.emit(`op.${e.op}`, e.identity!, { id: e.id, shift: e.shift ?? null, args });
    if (e.op === 'open_ticket') this.hq.store.bg(this.openTicket(e as WalEntry, args), 'open_ticket');
    return ack;
  }

  /** The GitHub repo of the project a worker belongs to (its charter), for the link of a PR given as a number. */
  private repoOfWorker(identity: string): string | null {
    const t = this.hq.store.db.prepare(`SELECT project, worktree FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
      .get(identity) as { project: string | null; worktree: string | null } | undefined;
    const project = t?.project ?? getIdentity(this.hq.store, identity)?.project;
    return project ? this.hq.awaiting.repoOf(project, t?.worktree ?? null) : null;
  }

  private apply(e: WalEntry, a: Record<string, unknown>): OpAck {
    const { mailbox, inbox } = this.hq;
    const need = (k: string) => { const v = s(a[k]); if (!v) throw new IngestError(400, `${e.op}: ${k} is required`, `חסר השדה \`${k}\``); return v; };
    switch (e.op) {
      case 'tell': {
        // mcp-company's `urgency` is the delivery priority (now|next|later); map it onto both axes.
        const pr = (['now', 'next', 'later'] as const).includes(a.urgency as Priority) ? (a.urgency as Priority) : 'next';
        const urgency: Urgency = pr === 'now' ? 'urgent' : pr === 'later' ? 'low' : 'normal';
        const to = need('to');
        // A display name ("יואב") instead of an id would wake a shift for an identity that doesn't exist.
        if (to !== OWNER && to !== 'hq' && !this.hq.identityExists(to)) {
          const n = mailbox.names;
          throw new IngestError(400, `tell: unknown identity ${to} (use the id, e.g. ${n.manager.id}, or ${OWNER} for ${n.owner.name})`,
            `ההודעה ל-"${to}" לא נשלחה: אין identity כזה. שלח שוב עם ה-id (מה שבסוגריים בכותרת ההודעה), למשל ${n.manager.id}, או ${OWNER} ${pre('ל', n.owner.name)}.`);
        }
        const m = mailbox.tell({ msg_id: e.id, from: e.identity, to, body: need('body'), priority: pr, urgency, ref: s(a.ref) });
        const estimate = this.estimate(e, a, s(a.body)?.split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 200) ?? null, false);
        return { ok: true, id: e.id, ref: m.id, ...(estimate ? { result: { estimate } } : {}) };
      }
      case 'ask': {
        const ask = mailbox.ask({ msg_id: e.id, from: e.identity, question: need('question'), headline: s(a.headline),
          options: strList(a.options), blocking: a.blocking === true });
        return { ok: true, id: e.id, ref: ask.id };
      }
      case 'withdraw_ask': {
        const id = need('ask');
        const ask = mailbox.getAsk(id);
        if (!ask || ask.from_identity !== e.identity) throw new IngestError(404, `withdraw_ask: no ask ${id} of ${e.identity}`, `אין שאלה פתוחה שלך עם המזהה ${id}`);
        return { ok: true, id: e.id, ref: id, result: { withdrawn: mailbox.withdraw(id, s(a.note)) } };
      }
      case 'withdraw_go': {
        const outcome = need('outcome');
        if (outcome !== 'approved_in_chat' && outcome !== 'withdrawn') {
          throw new IngestError(400, `withdraw_go: unknown outcome ${outcome}`, 'ה-`outcome` הוא `approved_in_chat` או `withdrawn`');
        }
        try {
          const r = mailbox.closeGo(need('ref'), outcome, e.identity, s(a.message), s(a.note));
          return { ok: true, id: e.id, ref: `inbox-${r.item.id}`, result: { closed: !r.already, state: r.item.state, ...(r.quote ? { quote: r.quote } : {}) } };
        } catch (err) {
          if (err instanceof GoCloseError) throw new IngestError(err.status, err.message, err.he);
          throw err;
        }
      }
      case 'request_go': {
        const what = need('what');
        const item = inbox.add({ kind: 'go', from_identity: e.identity, title: `GO: ${what}`.slice(0, 200), blocking: true,
          urgency: a.risk === 'high' ? 'urgent' : 'normal', ref: e.id, dedupe_key: `op:${e.id}`, headline: s(a.headline)?.trim() || null,
          links: requestGoLinks(a, this.repoOfWorker(e.identity)),
          body: [what, s(a.pr) ? `PR: ${String(a.pr)}` : '', s(a.risk) ? `סיכון: ${String(a.risk)}` : ''].filter(Boolean).join('\n') });
        return { ok: true, id: e.id, ref: `inbox-${item.id}` };
      }
      case 'open_ticket':
        need('repo'); need('title');
        return { ok: true, id: e.id, result: { queued: true } };
      case 'status': {
        // status{state: done} from a task worker closes its task (ends the shift with task_done).
        const done = a.state === 'done' || a.state === 'task_done';
        // A worker on a node that needs what exists only on the main server: the task moves there (Scheduler.moveLocal).
        if (a.state === 'needs-local') {
          const t = this.hq.store.db.prepare(`SELECT id, machine FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
            .get(e.identity) as { id: number; machine: string | null } | undefined;
          const there = !!t?.machine && t.machine !== 'local';
          if (t && there) this.hq.store.bg(this.hq.scheduler.moveLocal(t.id, s(a.note) ?? 'needs-local'), 'task.move_local');
          return { ok: true, id: e.id, result: { stored: true, moving: there ? t!.id : null,
            note: there ? 'בסוף הסבב המשמרת כאן נגמרת, והמשימה ממשיכה בשרת הראשי מהענף שלך' : 'המשימה כבר רצה בשרת הראשי: לא זז כלום' } };
        }
        const estimate = this.estimate(e, a, s(a.note) ?? null, done);
        if (done) {
          const t = this.hq.store.db.prepare(`SELECT id FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
            .get(e.identity) as { id: number } | undefined;
          if (t && taskSummary(a.summary)) this.hq.store.db.prepare('UPDATE tasks SET summary = ? WHERE id = ?').run(taskSummary(a.summary), t.id);
          // After its turn ends, and only if he isn't waiting for an answer from it (#118): else it stays open and hears why.
          if (t) this.hq.store.bg(this.hq.scheduler.finishByWorker(t.id, e.identity, e.id, () => { this.hq.awaiting.mark(t.id, a, e.identity); this.hq.estimates.close(e.identity, { all: true }); }), 'task.complete');
          if (!t) {
            this.hq.estimates.close(e.identity, { all: true });
            // A standing worker with no task open: done means "I am finished", so its shift rests now (not a manager or a resident).
            this.hq.store.bg(this.hq.scheduler.restIdle(e.identity), 'worker.rest_on_done');
          }
          return { ok: true, id: e.id, result: { stored: true, task_done: t?.id ?? null, ...(estimate ? { estimate } : {}) } };
        }
        return { ok: true, id: e.id, result: { stored: true, ...(estimate ? { estimate } : {}) } };
      }
      case 'open_team': {
        // Phase 1: a team opened by a worker is a task team = a task in the scheduler queue (B.16). The
        // opener is who the worker reports to (labels opened-by:<id>). Deduped on ref (e.g. an issue).
        const db = this.hq.store.db;
        const own = (db.prepare('SELECT project FROM identities WHERE id = ?').get(e.identity) as { project: string | null } | undefined)?.project;
        // assignee: the project's standing worker whose domain it is (the lead picks). Without one, a temporary worker.
        const assignee = s(a.assignee)?.trim() || undefined;
        const worker = assignee ? getIdentity(this.hq.store, assignee) : undefined;
        if (assignee && (!worker || !worker.active)) {
          throw new IngestError(400, `open_team: unknown assignee ${assignee}`, `אין עובד קבוע בשם \`${assignee}\` (ה-assignee הוא identity מ-org.yaml, למשל \`ido\`)`);
        }
        if (worker && !isStandingWorker(worker, this.hq.cfg.managerId)) {
          throw new IngestError(400, `open_team: ${assignee} is not a standing worker (lead, resident, manager or task worker)`,
            `\`${assignee}\` הוא לא עובד קבוע בצוות (ראש צוות, ${this.hq.cfg.managerId} ועובד משימה לא מקבלים משימה כ-assignee). בלי assignee נפתח עובד זמני`);
        }
        // A standing worker of a company-level permanent team (design's tom: no project) works on any project's
        // app: the task is the opener's project (or the one named), and the worktree is in that project's checkout.
        const companyWide = worker?.team_kind === 'permanent' && !worker.project;
        const project = s(a.project) ?? (worker?.project ?? own ?? undefined);
        if (worker && !companyWide && (worker.project ?? undefined) !== project) {
          throw new IngestError(400, `open_team: ${assignee} is not in project ${project ?? '(none)'}`,
            `\`${assignee}\` לא שייך לפרויקט \`${project ?? '(בלי פרויקט)'}\`${worker.project ? ` אלא ל-\`${worker.project}\`` : ''}`);
        }
        // 4xx, not a thrown 500: the WAL retries 5xx at its head forever and would hold back every later op.
        if (project != null && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)
          || (!existsSync(join(this.hq.cfg.companyDir, 'projects', `${project}.md`)) && !db.prepare('SELECT 1 FROM identities WHERE project = ?').get(project)))) {
          throw new IngestError(400, `open_team: unknown project ${project}`, `אין פרויקט בשם \`${project}\` (אין לו אמנה ב-company/projects/)`);
        }
        if (project != null && noWorkers(readCharter(this.hq.cfg.companyDir, project))) {
          throw new IngestError(400, `open_team: project ${project} is dormant or its charter is invalid; it gets workers only after it moves to the company`,
            `הפרויקט \`${project}\` רדום או שהאמנה שלו לא תקינה. הוא מקבל עובדים רק אחרי שהוא עובר לחברה (\`status: active\` באמנה)`);
        }
        // Same ticket while its task is still open → that task. A finished one is not reopened silently.
        const base = s(a.ref) ?? `team:${e.id}`;
        const open = db.prepare(`SELECT ref FROM tasks WHERE (ref = ? OR ref LIKE ? ESCAPE '\\') AND state != 'done' ORDER BY id DESC LIMIT 1`)
          .get(base, `${base.replace(/[\\%_]/g, (c) => `\\${c}`)} · %`) as { ref: string } | undefined;
        const taken = !open && db.prepare('SELECT 1 FROM tasks WHERE ref = ?').get(base);
        const ref = open?.ref ?? (taken ? `${base} · ${e.id}` : base);
        // priority: explicit 0..3 wins; else p0/p1 at the start of the title; else the scheduler's default.
        if (a.priority != null && (!Number.isInteger(a.priority) || (a.priority as number) < 0 || (a.priority as number) > 3)) {
          throw new IngestError(400, 'open_team: priority must be an integer 0..3', 'ה-`priority` חייב להיות מספר שלם בין 0 ל-3');
        }
        const priority = a.priority != null ? (a.priority as number) : titlePriority(need('name'));
        const task = this.hq.scheduler.addTask({
          title: need('name'), body: need('purpose'), project, ref, priority, labels: [`opened-by:${e.identity}`, ...(s(a.repo) ? [`repo:${s(a.repo)}`] : []),
            // Needs what exists only here: stays here (nodes.ts NEEDS_LOCAL). Default: wherever there is room.
            // `remote` (before 22/10) is ignored: every task may go to a node now.
            ...(a.local === true ? ['needs-local'] : [])],
          identity: worker?.id,
        });
        return { ok: true, id: e.id, ref: `task-${task.id}`, result: { task: task.id, state: task.state } };
      }
      case 'close_team': {
        // Closing = completing the task: its shift stops (task_done), the worktree is preserved and removed, and
        // nothing wakes it again. A team that isn't found or isn't the caller's to close is a 4xx with the reason.
        const team = need('team');
        const reason = s(a.reason);
        // MCP writes are acked locally ({queued:true}): the caller hears the reason, in Hebrew, in its mailbox (rejected()).
        const reject = (status: number, why: string, he: string): never => { throw new IngestError(status, why, he); };
        const { task: t, ambiguous } = this.hq.scheduler.findTeam(team);
        if (ambiguous) {
          const ids = ambiguous.map((x) => `t${x.id}`).join(', ');
          reject(409, `close_team: ${team} matches more than one open task (${ids})`, `הצוות "${team}" לא נסגר: השם מתאים לכמה משימות פתוחות (${ids}). סגור שוב עם המזהה.`);
        }
        if (!t) reject(404, `close_team: no team ${team}`, `הצוות "${team}" לא נסגר: אין משימה כזו. אפשר לסגור לפי מזהה (t22), לפי ה-identity של העובד (lumo-t22) או לפי השם שלו.`);
        if (!this.hq.scheduler.canCloseTeam(t!, e.identity)) {
          reject(403, `close_team: ${e.identity} may not close task ${t!.id}`, `הצוות "${team}" (t${t!.id}) לא נסגר: רק מי שפתח אותו, המנהל שלו, המנהל של העובד (או ראש הפרויקט, כשאין מי שפתח) או ${this.hq.cfg.managerId} יכולים לסגור.`);
        }
        // He is still waiting for an answer from the worker (#118): a warning the closer may override with force.
        const left = t!.state !== 'done' && t!.identity && a.force !== true ? mailbox.unanswered(t!.identity, t!.started_at ?? t!.created_at) : [];
        if (left.length) {
          reject(409, `close_team: the owner is waiting for an answer from ${t!.identity} (${left.map((m) => m.id).join(', ')})`,
            `הצוות "${team}" (t${t!.id}) לא נסגר: ${waitingLine(left, mailbox.names.owner.name)} מ-${mailbox.label(t!.identity!)}. `
            + `כדאי שהעובד יענה ${g(mailbox.names.owner, 'לו', 'לה')} קודם. אם בכל זאת לסגור, \`close_team\` שוב עם \`force: true\`.`);
        }
        // A GO of the worker's that he has not decided: closing would leave his answer without an owner (force: handed over).
        const gos = t!.state !== 'done' && t!.identity && a.force !== true ? mailbox.openGos(t!.identity, t!.started_at ?? t!.created_at) : [];
        if (gos.length) {
          reject(409, `close_team: ${t!.identity} has an open GO (inbox ${gos.map((x) => x!.id).join(', ')})`,
            `הצוות "${team}" (t${t!.id}) לא נסגר: בקשת ה-GO "${gos[0]!.headline ?? gos[0]!.title}" (inbox ${gos[0]!.id}) של ${mailbox.label(t!.identity!)} עדיין פתוחה. `
            + `חכה להחלטה. אם בכל זאת לסגור, \`close_team\` שוב עם \`force: true\`, והבקשה והתשובה עליה יעברו אליך.`);
        }
        // The closer's line wins over the worker's: it is the last word, written for him.
        if (taskSummary(a.summary)) this.hq.store.db.prepare('UPDATE tasks SET summary = ? WHERE id = ?').run(taskSummary(a.summary), t!.id);
        // Also on a task that is already done: the lead marks what it waits for after the fact (#108).
        this.hq.awaiting.mark(t!.id, a, e.identity);
        if (t!.state === 'done') return { ok: true, id: e.id, ref: `task-${t!.id}`, result: { task: t!.id, state: 'done', already: true } };
        const worker = t!.identity;
        // A standing worker writes its handoff first (its next task starts from it); closed by the sweep after the grace.
        if (this.hq.scheduler.closeWithHandoff(t!.id, e.identity, reason)) {
          return { ok: true, id: e.id, ref: `task-${t!.id}`, result: { task: t!.id, state: 'closing', handoff_grace_ms: this.hq.cfg.timers.handoffGraceMs } };
        }
        queueMicrotask(() => {
          // The reason reaches the worker before its shift stops (same host connection, written first).
          // A standing worker's task that never started: it is busy with another one, and that shift goes on.
          const waiting = t!.started_at == null && !!worker && isStandingWorker(getIdentity(this.hq.store, worker), this.hq.cfg.managerId);
          if (worker && reason) {
            try {
              mailbox.tell({ msg_id: `${e.id}-close`, from: e.identity, to: worker, kind: 'system', priority: waiting ? 'next' : 'now', ref: e.id,
                body: waiting ? `המשימה ${t!.ref ?? `#${t!.id}`} (${t!.title}) שחיכתה לך בתור בוטלה על ידי ${mailbox.label(e.identity)}: ${reason}`
                  : `הצוות נסגר על ידי ${mailbox.label(e.identity)}: ${reason}\nהמשמרת נעצרת עכשיו.` });
            } catch { /* best effort */ }
          }
          // Closed before it started: cancelled or handed over, not finished.
          this.hq.scheduler.markCancelled(t!.id);
          this.hq.store.bg(this.hq.scheduler.completeTask(t!.id), 'task.close');
        });
        return { ok: true, id: e.id, ref: `task-${t!.id}`, result: { task: t!.id, state: 'closing' } };
      }
      case 'compose_home': {
        if (!this.hq.home.mayCompose(e.identity)) {
          const c = this.hq.home.composer();
          throw new IngestError(403, `compose_home: ${e.identity} may not compose the home screen`,
            `רק ${c ? `${this.hq.mailbox.label(c)} (\`${c}\`) ו-` : ''}${this.hq.cfg.managerId} מרכיבים את ראש מסך השיחות`);
        }
        try {
          const r = this.hq.home.compose(a.blocks, e.identity, s(a.reason));
          return { ok: true, id: e.id, ref: `home-${r.version}`, result: { version: r.version, blocks: r.blocks.length } };
        } catch (err) {
          if (err instanceof HomeError) throw new IngestError(400, `compose_home: ${err.message}`, `המתכון לא נשמר: ${err.message}`);
          throw err;
        }
      }
      case 'remember': {
        // #115: `file` updates a memory file through hq (memory-files.ts), never by editing the main checkout.
        // Routed here and only here: a `registry` the client sent is never trusted.
        delete a.registry;
        if (a.file === undefined) return { ok: true, id: e.id, result: { stored: true } };
        const file = memoryFilePath(a.file);
        if (!file) throw new IngestError(400, `remember: file must be memory/<path>.md, got ${String(a.file)}`,
          `\`file\` צריך להיות נתיב יחסי לקובץ \`.md\` תחת \`memory/\`, למשל \`memory/projects/lumo-bot/open-ron.md\``);
        if (a.mode !== undefined && !(FILE_MODES as readonly unknown[]).includes(a.mode)) {
          throw new IngestError(400, `remember: mode must be append or replace`, '`mode` הוא `append` או `replace`');
        }
        need('text');
        if (a.base_sha !== undefined && !(typeof a.base_sha === 'string' && /^[0-9a-f]{7,40}$/i.test(a.base_sha))) {
          throw new IngestError(400, 'remember: base_sha must be a hex sha', '`base_sha` הוא ה-sha שחזר ב-`recall` עם הנתיב (40 תווים הקסדצימליים)');
        }
        const text = String(a.text);
        if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
          throw new IngestError(400, `remember: text is over ${MAX_TEXT_BYTES} bytes`, `הטקסט גדול מ-${MAX_TEXT_BYTES / 1024}KB`);
        }
        const secret = secretIn(text);
        if (secret) {
          throw new IngestError(400, `remember: text looks like a secret (${secret})`,
            `בטקסט יש משהו שנראה כמו סוד (${secret}). סודות לא נכנסים לקבצי זיכרון: כותבים איפה הסוד שמור, לא את הסוד עצמו`);
        }
        a.file = file;
        const registry = this.hq.memoryFiles.registry;
        if (registry.isRegistry(file)) {
          const why = registry.refuse(e.identity, file);
          if (why) throw new IngestError(403, `remember: ${file} is not a registry ${e.identity} may write`, why);
          // Straight to main, through the one queue, right after this op is stored (same transaction, then a microtask).
          a.registry = true;
          queueMicrotask(() => this.hq.store.bg(registry.kick(), 'memory.registry'));
          return { ok: true, id: e.id, result: { stored: true, file, commit: 'queued' } };
        }
        return { ok: true, id: e.id, result: { stored: true, file, pr: 'pending' } };
      }
      default:
        // remember / handoff / status: stored durably now (ops table),
        // consumed by memory consolidation, prime.json (handoff) and the board.
        return { ok: true, id: e.id, result: { stored: true } };
    }
  }

  /**
   * The `eta_*` fields of a tell or status (estimates.ts). `eta_done` and status done close the worker's open estimate with the real
   * time; eta_min|eta_at + eta_kind (+ eta_what) record a new one. The op itself is never rejected for them: a bad
   * estimate is answered from hq in the worker's mailbox, and so is the calibration (the MCP ack is local, long before this).
   */
  private estimate(e: WalEntry, a: Record<string, unknown>, fallbackWhat: string | null, taskDone: boolean): Record<string, unknown> | undefined {
    const { estimates, mailbox, store } = this.hq;
    const say = (suffix: string, body: string) => mailbox.tell({ msg_id: `${e.id}-${suffix}`, from: 'hq', to: e.identity, kind: 'system', priority: 'next', ref: e.id, body });
    const out: Record<string, unknown> = {};
    const what = typeof a.eta_what === 'string' ? a.eta_what.split('\n').map((x) => x.trim()).find(Boolean) : undefined;
    // status done closes them when the task really closes (finishByWorker, after the owner's questions are answered), not here.
    if (a.eta_done === true) {
      const closed = estimates.close(e.identity, { what });
      if (closed.length) out.closed = closed.map((x) => estimates.view(x));
    }
    if (taskDone) return out.closed ? out : undefined; // no new estimate with done
    let eta;
    try { eta = parseEta(a, store.now(), this.hq.timeZone(), fallbackWhat); }
    catch (err) {
      if (!(err instanceof EstimateError)) throw err;
      say('estimate-rejected', err.he);
      return { error: err.message };
    }
    if (eta) {
      const t = store.db.prepare(`SELECT id, project FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
        .get(e.identity) as { id: number; project: string | null } | undefined;
      const own = (store.db.prepare('SELECT project FROM identities WHERE id = ?').get(e.identity) as { project: string | null } | undefined)?.project;
      const r = estimates.register({ identity: e.identity, shift: e.shift ?? null, task: t?.id ?? null, project: t?.project ?? own ?? null,
        messageId: e.op === 'tell' ? e.id : null, ...eta });
      // A suggestion that equals what the worker wrote is not worth a message.
      if (r.suggestion.minutes !== r.estimate.estimated_min) say('estimate', r.suggestion.line);
      out.id = r.estimate.id; out.suggestion = r.suggestion; out.updated = r.updated;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * MCP writes are acked locally ({queued:true}) and the WAL drops a 4xx without retrying, so a rejection
   * would otherwise vanish (#69). The sender gets it in its mailbox, with the reason, and the board an event.
   * Idempotent on the op id: a resend of the same rejected op does not repeat the message.
   */
  private rejected(e: WalEntry, err: IngestError): void {
    const msgId = `${e.id}-rejected`;
    try {
      if (this.hq.mailbox.get(msgId)) return;
      const body = `\`${e.op}\` נדחה ב-hq: ${err.he ?? err.message}`;
      // open_team already returned the rejection as its tool result, unless hq answered too late: no need to interrupt.
      this.hq.mailbox.tell({ msg_id: msgId, from: 'hq', to: e.identity, kind: 'system', priority: e.op === 'open_team' ? 'next' : 'now', ref: e.id, body });
      this.hq.store.emit('op.rejected', e.identity, { id: e.id, shift: e.shift ?? null, op: e.op, status: err.status, error: err.message, reason: body });
    } catch (x) {
      this.hq.store.emit('loop.error', null, { loop: 'op.rejected', error: x instanceof Error ? x.message : String(x) });
    }
  }

  /**
   * status done waits for the worker's turn in memory (#118): one that an hq restart cut off is finished now. A task
   * still running whose worker's latest status since it started is done, and that was not already sent back.
   */
  resumePendingDone(): number {
    const rows = this.hq.store.db.prepare(`SELECT t.id AS task, t.identity, o.id, o.args FROM tasks t JOIN ops o ON o.identity = t.identity
      AND o.op = 'status' AND o.received_at >= COALESCE(t.started_at, t.created_at)
      WHERE t.state IN ('running','resting') AND t.identity IS NOT NULL
        AND o.received_at = (SELECT MAX(received_at) FROM ops x WHERE x.identity = t.identity AND x.op = 'status')`).all() as
      { task: number; identity: string; id: string; args: string }[];
    let n = 0;
    for (const r of rows) {
      const a = JSON.parse(r.args) as Record<string, unknown>;
      if ((a.state !== 'done' && a.state !== 'task_done') || this.hq.mailbox.get(`${r.id}-waiting`)) continue;
      this.hq.store.bg(this.hq.scheduler.finishByWorker(r.task, r.identity, r.id, () => this.hq.awaiting.mark(r.task, a, r.identity)), 'task.complete');
      n++;
    }
    return n;
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
    const memDir = join(this.hq.cfg.companyHome, 'memory');
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

  /**
   * recall, and when a query is a memory file path (`memory/…/open-ron.md`), that file first, whole, as it will be
   * once the updates waiting for the memory PR land (#115): what a worker reads before `remember` with `mode: replace`.
   */
  async recallWithFiles(raw: unknown): Promise<RecallResponse> {
    const res = this.recall(raw);
    const r = raw as Partial<RecallRequest> & { queries?: unknown };
    const file = [r.query, ...strList(r.queries)].map(memoryFilePath).find((f): f is string => !!f);
    if (!file) return res;
    const text = await this.hq.memoryFiles.current(file);
    // A registry also returns its base_sha, for a replace (memory-registry.ts); a file that does not exist yet has none.
    const sha = text != null && this.hq.memoryFiles.registry.isRegistry(file) ? { base_sha: blobSha(text) } : {};
    if (text == null) return res;
    return { ...res, items: [{ ref: file, scope: 'file', title: file, text, score: 100, ...sha }, ...res.items.filter((i) => i.ref !== file)] };
  }

  /** For prime.json: the top record's full body (bet 9) plus the next refs as an index. */
  primeRecall(identity: string, query: string): { top?: { ref: string; body: string }; others: string[] } {
    const project = (this.hq.store.db.prepare('SELECT project FROM identities WHERE id = ?').get(identity) as { project: string | null } | undefined)?.project;
    let { items } = this.recall({ identity, shift: '', query, limit: 8 });
    if (project) items = [...items.filter((i) => i.ref.includes(`projects/${project}/`)), ...items.filter((i) => !i.ref.includes(`projects/${project}/`))];
    if (!items.length) return { others: [] };
    const [first, ...rest] = items;
    const memRoot = this.hq.cfg.companyHome;
    const body = first!.ref.startsWith('memory/') ? readFileSync(join(memRoot, first!.ref), 'utf8') : first!.text;
    return { top: { ref: first!.ref, body }, others: rest.map((i) => i.ref) };
  }

  /** B.9: browser-memory's browser_ask_user creates a handoff and waits on it here. */
  private async handoff(method: string, id: string | undefined, end: boolean, url: URL, readBody: () => Promise<unknown>,
    signal: AbortSignal): Promise<unknown> {
    const tab = this.hq.tab;
    if (!id && method === 'POST') {
      const b = (await readBody()) as Record<string, unknown>;
      const from = s(b.identity) ?? s(b.from) ?? null;
      if (from && !this.hq.identityExists(from) && from !== OWNER) throw new IngestError(400, `unknown identity ${from}`);
      return { ok: true, ...(await tab.create({ from, target: s(b.target), url: s(b.url), what: s(b.what), need: s(b.need),
        ttlMin: typeof b.ttl_min === 'number' ? b.ttl_min : undefined })) };
    }
    if (id && !end && method === 'GET') {
      const v = await tab.wait(id, Number(url.searchParams.get('wait') ?? 0), signal);
      if (!v) throw new IngestError(404, `no handoff ${id}`);
      return { ok: true, handoff: v };
    }
    if (id && end && method === 'POST') {
      const b = (await readBody()) as Record<string, unknown>;
      const state = s(b.state) ?? 'done';
      if (state !== 'done' && state !== 'cancelled') throw new IngestError(400, 'state must be done|cancelled');
      const v = tab.end(id, state, 'worker', s(b.final_url));
      if (!v) throw new IngestError(404, `no handoff ${id}`);
      return { ok: true, handoff: v };
    }
    throw new IngestError(405, 'method not allowed');
  }

  /** Route a request; returns false if the path is not ours. */
  async handle(req: IncomingMessage, res: ServerResponse, readBody: () => Promise<unknown>): Promise<boolean> {
    const url = requestUrl(req);
    if (!url) return false;
    const path = url.pathname;
    const handoff = /^\/v1\/handoffs(?:\/(h-[0-9a-f]+)(\/end)?)?$/.exec(path);
    if (!handoff && (req.method !== 'POST' || (path !== '/v1/ops' && path !== '/v1/recall' && path !== '/v1/access' && path !== '/v1/resources' && path !== '/v1/lease'))) return false;
    let status = 200, out: unknown;
    try {
      if (handoff) {
        // A long-poll whose caller went away (tool call cancelled, gateway died) stops being a waiter.
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) gone.abort(); });
        out = await this.handoff(req.method ?? 'GET', handoff[1], !!handoff[2], url, readBody, gone.signal);
      }
      else {
        const body = await readBody();
        out = path === '/v1/ops' ? this.op(body) : path === '/v1/resources' ? { text: this.hq.resources.text() } : path === '/v1/access' ? await this.hq.access.request(body) : path === '/v1/lease' ? await this.hq.leases.request(body) : await this.recallWithFiles(body);
      }
    } catch (e) {
      status = e instanceof IngestError || e instanceof HandoffError || e instanceof AccessError || e instanceof LeaseError ? e.status : (e as { status?: number }).status ?? 500;
      out = { ok: false, error: (e as Error).message, ...(e instanceof IngestError && e.he ? { reason: e.he } : {}),
        ...(e instanceof HandoffError && e.busy ? { busy: e.busy } : {}) };
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
  const srv = createServer(guarded(async (req, res) => {
    if (!(await ingest.handle(req, res, () => readJson(req)))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
  }));
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(path, () => resolve()); });
  chmodSync(path, 0o600);
  return srv;
}

/** A task's closing line (#53): one line, trimmed, at most 200 characters; empty = none. */
export function taskSummary(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const line = v.split('\n')[0]!.trim();
  return line ? line.slice(0, 200) : null;
}

/** The links of a GO: its report and PR. A bare PR number becomes a link in the worker's project repo, when it has one. */
function requestGoLinks(a: Record<string, unknown>, repo: string | null): InboxLink[] {
  const https = (v: unknown) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim()) ? v.trim() : null);
  const report = https(a.report);
  const n = prNumber(a.pr);
  const pr = https(a.pr) ?? (n && repo ? `https://github.com/${repo}/pull/${n}` : null);
  return [...(report ? [{ kind: 'report' as const, url: report }] : []), ...(pr ? [{ kind: 'pr' as const, url: pr }] : [])];
}
