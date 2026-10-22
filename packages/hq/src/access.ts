// request_access: hq runs a command in the worker's name (two-servers-access-design.md, phase 1). The keys stay on the
// main server; a worker on the second one asks for `{resource, argv}` and gets the output back. hq builds the command
// itself from closed lists (access-policy.ts), decides who approves, runs it as a detached job and keeps a log.
//   read, with a grant in the charter        → runs at once (approved_by auto:grant)
//   anything else outside prod               → a GO card with the exact command, the worker comes back with `request`
//   write or exec in prod, whatever grants   → always a card, every time
//   not in the lists                         → `unfit` (an event, counted after a week), with a hint
// Nothing here copies a secret anywhere: the catalog (<state>/access/catalog.json) only points at what is already on this machine.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { OWNER } from '@company/shared';
import type { Hq } from './hq.ts';
import { getIdentity } from './org.ts';
import { readCharter } from './workspace.ts';
import { parseCatalog, planAccess, redact, type AccessClass, type Catalog, type Plan, type Resource } from './access-policy.ts';

/** At most this many at once: the runs are only a relay (ssh, kubectl), but the server is shared. */
export const MAX_RUNNING = 6;
export const DEFAULT_WAIT_S = 90;
export const MAX_WAIT_S = 100;
export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 1800;
export const TAIL_LINES = 200;
const TAIL_CHARS = 20_000;
const LOG_LIMIT_BLOCKS = 2048; // ulimit -f, 512-byte blocks: 1MB a job
const QUERY_ROWS = 200;
const QUERY_MS = 10_000;

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type State = 'pending' | 'running' | 'done' | 'failed' | 'denied' | 'unfit' | 'cancelled';

export interface AccessRow {
  id: number; identity: string; shift: string | null; task: number | null; project: string | null; resource: string; argv: string; shown: string; why: string;
  class: AccessClass | null; state: State; approved_by: string | null; inbox_id: number | null; exit_code: number | null; note: string | null;
  created_at: number; decided_at: number | null; started_at: number | null; finished_at: number | null;
}

/** What request_access answers. `message` is Hebrew and says what to do next; `hint` is the way to fit the lists. */
export interface AccessReply {
  status: 'done' | 'failed' | 'running' | 'pending' | 'denied' | 'unfit' | 'cancelled';
  request?: string;
  message: string;
  output?: string;
  exit_code?: number;
  truncated?: boolean;
  hint?: string;
}

export interface JobSpec { id: number; cmd: string; args: string[]; logPath: string; exitPath: string; timeoutSec: number }
export interface JobRunner {
  start(j: JobSpec): Promise<void>;
  /** Ends a job that runs: the unit, or the process group of the fallback. */
  stop(j: { id: number; exitPath: string }): Promise<void>;
}

const SCRIPT = 'ulimit -f "$4"; log=$1; ex=$2; secs=$3; shift 4; timeout -k 10 "$secs" "$@" >"$log" 2>&1 </dev/null; echo $? >"$ex.tmp"; mv "$ex.tmp" "$ex"';

/** A job outlives hq: a transient user unit (systemd-run), else a detached process. Output goes to a file, the exit code to another. */
export class SystemdRunner implements JobRunner {
  async start(j: JobSpec): Promise<void> {
    const sh = ['/bin/sh', '-c', SCRIPT, 'sh', j.logPath, j.exitPath, String(j.timeoutSec), String(LOG_LIMIT_BLOCKS), j.cmd, ...j.args];
    const viaSystemd = await new Promise<boolean>((resolve) => {
      execFile('systemd-run', ['--user', '--quiet', '--collect', `--unit=company-access-${j.id}`, `--setenv=PATH=${process.env.PATH ?? '/usr/bin:/bin'}`,
        `-p`, `RuntimeMaxSec=${j.timeoutSec + 30}`, ...sh], { timeout: 15_000 }, (err) => resolve(!err));
    });
    if (viaSystemd) return;
    // No systemd (a machine with no user bus): a process group of its own, whose id is kept next to the exit file, so a cancel can end it.
    const child = spawn(sh[0]!, sh.slice(1), { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* the exit file never appears: the request ends as lost */ });
    if (child.pid) { try { writeFileSync(`${j.exitPath}.pid`, String(child.pid)); } catch { /* the job runs; only a cancel loses its handle */ } }
    child.unref();
  }
  async stop(j: { id: number; exitPath: string }): Promise<void> {
    await new Promise<void>((resolve) => { execFile('systemctl', ['--user', 'stop', `company-access-${j.id}.service`], { timeout: 15_000 }, () => resolve()); });
    try {
      const pid = Number(readFileSync(`${j.exitPath}.pid`, 'utf8'));
      if (Number.isInteger(pid) && pid > 1) process.kill(-pid, 'SIGTERM');
    } catch { /* no pid file, or it already ended */ }
  }
}

const CLASS_HE: Record<AccessClass, string> = { read: 'קריאה', write: 'שינוי', exec: 'הרצת פקודה בתוך ה-pod' };
const asS = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export class Access {
  private hq: Hq;
  runner: JobRunner;
  private cache: { at: number; mtime: number; catalog: Catalog } | null = null;

  constructor(hq: Hq, runner: JobRunner = new SystemdRunner()) {
    this.hq = hq;
    this.runner = runner;
  }

  private get dir(): string { return join(this.hq.cfg.stateDir, 'access'); }
  private jobs(): string { const d = join(this.dir, 'jobs'); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
  private logPath(id: number) { return join(this.jobs(), `${id}.log`); }
  private exitPath(id: number) { return join(this.jobs(), `${id}.exit`); }
  private get db() { return this.hq.store.db; }
  private now() { return this.hq.store.now(); }

  /** The catalog file, read again when it changed. A broken file is no catalog: nothing runs. */
  catalog(): Catalog {
    const file = join(this.dir, 'catalog.json');
    if (!existsSync(file)) return {};
    const mtime = statSync(file).mtimeMs;
    if (this.cache && this.cache.mtime === mtime) return this.cache.catalog;
    let catalog: Catalog = {};
    try {
      const r = parseCatalog(JSON.parse(readFileSync(file, 'utf8')));
      catalog = r.catalog;
      if (r.problems.length) this.hq.store.emit('access.catalog_problems', null, { problems: r.problems });
    } catch (e) {
      this.hq.store.emit('access.catalog_problems', null, { problems: [(e as Error).message] });
    }
    this.cache = { at: this.now(), mtime, catalog };
    return catalog;
  }

  /** Who is asking: a live shift of that identity, its task and project. Anything else is not a worker of ours. */
  private caller(identity: string, shift: string): { task: number | null; project: string | null } {
    const row = this.db.prepare('SELECT identity, state FROM shifts WHERE id = ?').get(shift) as { identity: string; state: string } | undefined;
    if (!row || row.identity !== identity || (row.state !== 'live' && row.state !== 'starting')) {
      throw new AccessError(403, `request_access: no live shift ${shift} of ${identity}`);
    }
    const t = this.db.prepare(`SELECT id, project FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
      .get(identity) as { id: number; project: string | null } | undefined;
    return { task: t?.id ?? null, project: t?.project ?? getIdentity(this.hq.store, identity)?.project ?? null };
  }

  private row(id: number): AccessRow | undefined {
    return this.db.prepare('SELECT * FROM access_requests WHERE id = ?').get(id) as AccessRow | undefined;
  }

  private setState(id: number, state: State, f: Partial<Pick<AccessRow, 'approved_by' | 'exit_code' | 'note' | 'decided_at' | 'started_at' | 'finished_at' | 'inbox_id'>> = {}): void {
    const keys = Object.keys(f);
    this.db.prepare(`UPDATE access_requests SET state = @state${keys.map((k) => `, ${k} = @${k}`).join('')} WHERE id = @id`).run({ id, state, ...f });
  }

  /** The entry point of POST /v1/access. */
  async request(body: unknown): Promise<AccessReply> {
    const b = (body ?? {}) as Record<string, unknown>;
    const identity = asS(b.identity), shift = asS(b.shift);
    if (!identity || !shift) throw new AccessError(400, 'request_access: identity and shift are required');
    const who = this.caller(identity, shift);
    const waitS = Math.min(MAX_WAIT_S, Math.max(0, typeof b.wait === 'number' ? b.wait : DEFAULT_WAIT_S));
    const ref = asS(b.request) ?? asS(b.cancel);
    if (ref) {
      const id = Number(/^acc-(\d+)$/.exec(ref)?.[1]);
      const row = Number.isInteger(id) ? this.row(id) : undefined;
      if (!row || row.identity !== identity) throw new AccessError(404, `request_access: no request ${ref} of ${identity}`);
      return asS(b.cancel) ? this.cancel(row) : this.advance(row, waitS);
    }
    const resource = asS(b.resource);
    const argv = Array.isArray(b.argv) ? b.argv : null;
    if (!resource || !argv || !argv.length || argv.some((a) => typeof a !== 'string')) {
      throw new AccessError(400, 'request_access: resource and argv (a list of strings) are required');
    }
    return this.create(identity, shift, who, resource, argv as string[], asS(b.why) ?? '', waitS);
  }

  private async create(identity: string, shift: string, who: { task: number | null; project: string | null }, resource: string, argv: string[], why: string, waitS: number): Promise<AccessReply> {
    const catalog = this.catalog();
    const res: Resource | undefined = catalog[resource];
    const insert = (state: State, cls: AccessClass | null, shown: string, note: string | null) => Number(this.db.prepare(
      `INSERT INTO access_requests (identity, shift, task, project, resource, argv, shown, why, class, state, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(identity, shift, who.task, who.project, resource, JSON.stringify(argv), shown, why, cls, state, note, this.now()).lastInsertRowid);
    const refused = (kind: 'unfit' | 'denied', why2: string, hint?: string): AccessReply => {
      const id = insert(kind, null, `${resource} ${argv.join(' ')}`.slice(0, 500), why2);
      this.hq.store.emit(kind === 'unfit' ? 'access.unfit' : 'access.denied', identity, { request: id, resource, argv, project: who.project, why: why2 });
      return { status: kind, request: `acc-${id}`, message: `${kind === 'unfit' ? 'לא מתאים לרשימה' : 'נדחה'}: ${why2}`, ...(hint ? { hint } : {}) };
    };

    if (!res) {
      const names = Object.entries(catalog).filter(([, r]) => !r.projects || (who.project && r.projects.includes(who.project))).map(([n]) => n);
      return refused('unfit', `אין משאב בשם \`${resource}\` בקטלוג`, names.length ? `משאבים שזמינים למשימה הזו: ${names.join(', ')}` : 'הקטלוג ריק או לא נטען. המשימה תמשיך בשרת הראשי');
    }
    if (res.projects && !(who.project && res.projects.includes(who.project))) return refused('denied', `המשאב \`${resource}\` לא פתוח לפרויקט ${who.project ?? '(בלי פרויקט)'}`);
    const verdict = planAccess(resource, res, argv);
    if (!verdict.ok) return refused(verdict.kind === 'deny' ? 'denied' : 'unfit', verdict.why, verdict.hint);

    const plan = verdict.plan;
    const prod = res.env === undefined || res.env === 'prod';
    const grant = who.project ? readCharter(this.hq.cfg.companyDir, who.project)?.access.find((g) => g.resource === resource && g.verbs.includes(plan.class)) : undefined;
    // Write or exec in prod is his every time, whatever the charter says. Everything a grant does not cover is a card, too.
    const auto = !!grant && !(prod && plan.class !== 'read');
    const id = insert('pending', plan.class, plan.shown, null);
    this.hq.store.emit('access.requested', identity, { request: id, resource, argv, class: plan.class, project: who.project, shown: plan.shown, why });
    const row = this.row(id)!;
    if (auto) {
      this.setState(id, 'pending', { approved_by: 'auto:grant', decided_at: this.now() });
      this.hq.store.emit('access.granted', identity, { request: id, by: 'auto:grant', quote: grant!.quote });
      return this.start(this.row(id)!, plan, waitS);
    }
    const item = this.hq.inbox.add({
      kind: 'go', from_identity: identity, blocking: true, urgency: prod ? 'urgent' : 'normal', ref: `acc-${id}`, dedupe_key: `access:${id}`,
      title: `GO: ${plan.shown}`.slice(0, 200),
      headline: `להחליט אם לאשר ל${this.hq.mailbox.label(identity)} להריץ ב-${resource}`,
      body: [`הפקודה המדויקת:\n${plan.shown}`, `משאב: ${resource}${prod ? ' (פרודקשן)' : ''}`, `סוג: ${CLASS_HE[plan.class]}`, why ? `למה: ${why}` : '',
        prod && plan.class !== 'read' ? 'סיכון: high. כתיבה לפרודקשן נשאלת בכל פעם' : '', 'אישור מריץ את הפקודה הזו פעם אחת, ולא יותר.'].filter(Boolean).join('\n'),
    });
    this.setState(id, 'pending', { inbox_id: item.id });
    return this.advance({ ...row, inbox_id: item.id }, Math.min(waitS, 30), plan);
  }

  /** The state of a request after the worker came back for it: wait for the decision, wait for the job, or tell how it ended. The row is read again at every step: another call may have moved it. */
  private async advance(row: AccessRow, waitS: number, plan?: Plan): Promise<AccessReply> {
    const until = Date.now() + waitS * 1000;
    let r = row;
    while (r.state === 'pending') {
      const d = this.decision(r);
      if (d === 'yes') return this.start(r, plan ?? this.replan(r), Math.max(0, (until - Date.now()) / 1000), r.approved_by ? undefined : 'owner');
      if (d === 'no') {
        const res = this.db.prepare(`UPDATE access_requests SET state = 'denied', decided_at = ?, note = ? WHERE id = ? AND state = 'pending'`)
          .run(this.now(), 'רן דחה, או שהכרטיס נסגר בלי אישור שלו', r.id);
        if (res.changes) this.hq.store.emit('access.denied', r.identity, { request: r.id, by: 'owner' });
        r = this.row(r.id)!;
        continue;
      }
      if (Date.now() >= until) {
        return { status: 'pending', request: `acc-${r.id}`,
          message: `מחכה לאישור של רן על: ${r.shown}. המשך במה שלא תלוי בזה, וחזור עם \`request: "acc-${r.id}"\`. הוא ידע שחיכית.` };
      }
      await sleep(Math.min(1000, until - Date.now()));
      r = this.row(r.id)!;
    }
    if (r.state === 'running') return this.watch(r, until);
    return this.view(r);
  }

  /** His verdict on the card: yes, no, or still open. Yes is his own close (mailbox.complete / reply record who closed it and whether he declined); a card closed by anyone else is not an approval. */
  private decision(r: AccessRow): 'yes' | 'no' | 'open' {
    if (r.approved_by) return 'yes'; // approved by a grant, and waiting only for a free place to run
    const item = r.inbox_id ? this.hq.inbox.get(r.inbox_id) : undefined;
    if (!item) return 'no';
    if (item.state === 'open') return 'open';
    if (item.state === 'dismissed') return 'no';
    const ev = this.db.prepare(`SELECT data FROM events WHERE type = 'inbox.completed' AND json_extract(data, '$.id') = ? ORDER BY seq DESC LIMIT 1`).get(item.id) as { data: string } | undefined;
    if (!ev) return 'no';
    const d = JSON.parse(ev.data) as { declined?: boolean; by?: string };
    return d.by === OWNER && !d.declined ? 'yes' : 'no';
  }

  private replan(r: AccessRow): Plan {
    const res = this.catalog()[r.resource];
    const v = res ? planAccess(r.resource, res, JSON.parse(r.argv) as string[]) : null;
    if (!v?.ok) throw new AccessError(409, `request_access: ${r.resource} no longer in the catalog`);
    return v.plan;
  }

  /** Takes the request from pending to running, once: whoever gets false lost the race and only watches. */
  private claim(id: number, by: string | undefined): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE access_requests SET state = 'running', started_at = @now, decided_at = COALESCE(decided_at, @now), approved_by = COALESCE(approved_by, @by) WHERE id = @id AND state = 'pending'`)
      .run({ id, now, by: by ?? null }).changes === 1;
  }

  private async start(r: AccessRow, plan: Plan, waitS: number, by?: string): Promise<AccessReply> {
    if (plan.kind === 'process') {
      const now = this.now();
      const running = (this.db.prepare(`SELECT id, started_at FROM access_requests WHERE state = 'running'`).all() as { id: number; started_at: number | null }[])
        .filter((x) => !existsSync(this.exitPath(x.id)) && now - (x.started_at ?? now) < (DEFAULT_TIMEOUT_S + 60) * 1000).length;
      if (running >= MAX_RUNNING) {
        if (by) this.setState(r.id, 'pending', { approved_by: by, decided_at: now });
        return { status: 'pending', request: `acc-${r.id}`, message: `יש כבר ${MAX_RUNNING} פעולות שרצות. אושר, ולא רץ. חזור עוד דקה עם \`request: "acc-${r.id}"\`.` };
      }
    }
    if (!this.claim(r.id, by)) return this.advance(this.row(r.id)!, waitS);
    if (by === 'owner') this.hq.store.emit('access.granted', r.identity, { request: r.id, by: 'owner' });
    const cur = this.row(r.id)!;
    if (plan.kind === 'query') {
      // Written like any job's output, so a second call finds the same answer.
      const out = await this.query(plan.sql);
      writeFileSync(this.logPath(r.id), out.text);
      writeFileSync(this.exitPath(r.id), `${out.code}\n`);
      return this.watch(cur, Date.now() + 1000);
    }
    try {
      await this.runner.start({ id: r.id, cmd: plan.cmd, args: plan.args, logPath: this.logPath(r.id), exitPath: this.exitPath(r.id), timeoutSec: DEFAULT_TIMEOUT_S });
    } catch (e) {
      return this.finish(cur, 127, `לא הצלחתי להפעיל: ${(e as Error).message}`, true);
    }
    return this.watch(cur, Date.now() + waitS * 1000);
  }

  private async watch(r: AccessRow, until: number): Promise<AccessReply> {
    while (true) {
      if (existsSync(this.exitPath(r.id))) {
        const code = Number(readFileSync(this.exitPath(r.id), 'utf8').trim());
        return this.finish(r, Number.isFinite(code) ? code : 1, this.readLog(r.id));
      }
      // Gone without an exit file (the unit died with the machine): the job is lost, say so.
      if (r.started_at && this.now() - r.started_at > (DEFAULT_TIMEOUT_S + 60) * 1000) return this.finish(r, 1, 'הפעולה נעלמה בלי קוד יציאה', true);
      if (Date.now() >= until) break;
      await sleep(Math.min(250, until - Date.now()));
    }
    return { status: 'running', request: `acc-${r.id}`, message: `עדיין רץ: ${r.shown}. חזור עם \`request: "acc-${r.id}"\` (ואפשר \`wait\` עד ${MAX_WAIT_S} שניות). הפלט נשמר גם אם hq יופעל מחדש.` };
  }

  private finish(r: AccessRow, code: number, text: string, lost = false): AccessReply {
    const cur = this.row(r.id)!;
    if (cur.state === 'running') {
      this.setState(r.id, code === 0 ? 'done' : 'failed', { exit_code: code, finished_at: this.now(), ...(lost ? { note: 'lost' } : {}) });
      this.hq.store.emit('access.ran', r.identity, { request: r.id, resource: r.resource, shown: r.shown, exit_code: code, ms: this.now() - (r.started_at ?? this.now()) });
    }
    return this.view(this.row(r.id)!, text);
  }

  private view(r: AccessRow, text?: string): AccessReply {
    const rid = `acc-${r.id}`;
    if (r.state === 'denied' || r.state === 'unfit' || r.state === 'cancelled') return { status: r.state, request: rid, message: r.note ?? r.state };
    if (r.state === 'pending') return { status: 'pending', request: rid, message: 'מחכה לאישור' };
    if (r.state === 'running') return { status: 'running', request: rid, message: 'עדיין רץ' };
    const raw = text ?? this.readLog(r.id);
    const lines = redact(raw).split('\n');
    let out = lines.slice(-TAIL_LINES).join('\n');
    const truncated = lines.length > TAIL_LINES || out.length > TAIL_CHARS;
    if (out.length > TAIL_CHARS) out = out.slice(-TAIL_CHARS);
    return { status: r.state === 'done' ? 'done' : 'failed', request: rid, exit_code: r.exit_code ?? undefined, output: out, ...(truncated ? { truncated: true } : {}),
      message: r.state === 'done' ? 'הסתיים' : `נכשל (קוד יציאה ${String(r.exit_code)})` };
  }

  private readLog(id: number): string {
    const f = this.logPath(id);
    if (!existsSync(f)) return '';
    const size = statSync(f).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(f, 'r');
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    return buf.toString('utf8');
  }

  private async cancel(r: AccessRow): Promise<AccessReply> {
    if (r.state === 'pending') {
      if (r.inbox_id) this.hq.inbox.resolve(r.inbox_id, 'dismissed');
      this.db.prepare(`UPDATE access_requests SET state = 'cancelled', note = ?, finished_at = ? WHERE id = ? AND state = 'pending'`).run('בוטל על ידי המבקש', this.now(), r.id);
    } else if (r.state === 'running') {
      this.setState(r.id, 'cancelled', { note: 'בוטל בזמן ריצה', finished_at: this.now() });
      await this.runner.stop({ id: r.id, exitPath: this.exitPath(r.id) });
    }
    this.hq.store.emit('access.revoked', r.identity, { request: r.id });
    return this.view(this.row(r.id)!);
  }

  /** hq:query — a SELECT on hq.db in a child process (a heavy one must not stop hq), read-only, bounded in rows and time. */
  private query(sql: string): Promise<{ code: number; text: string }> {
    const script = `const D=require(process.argv[1]);const db=new D(process.argv[2],{readonly:true,fileMustExist:true});db.pragma('query_only = ON');`
      + `const rows=[];for(const r of db.prepare(process.argv[3]).iterate()){rows.push(r);if(rows.length>=${QUERY_ROWS})break}`
      + `process.stdout.write(rows.map(r=>JSON.stringify(r)).join('\\n')+(rows.length>=${QUERY_ROWS}?'\\n[נחתך ב-${QUERY_ROWS} שורות]':''))`;
    const driver = createRequire(import.meta.url).resolve('better-sqlite3');
    return new Promise((resolve) => {
      execFile(process.execPath, ['-e', script, driver, this.hq.cfg.dbPath, sql], { timeout: QUERY_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) resolve({ code: 1, text: (stderr || err.message).split('\n').slice(0, 5).join('\n') });
        else resolve({ code: 0, text: stdout });
      });
    });
  }

  /** For the app and for the weekly count: the last days of requests, newest first. */
  list(days = 7): AccessRow[] {
    return this.db.prepare('SELECT * FROM access_requests WHERE created_at >= ? ORDER BY id DESC LIMIT 500').all(this.now() - days * 86_400_000) as AccessRow[];
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export function writeCatalog(stateDir: string, catalog: unknown): void {
  mkdirSync(join(stateDir, 'access'), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'access', 'catalog.json'), JSON.stringify(catalog, null, 2), { mode: 0o600 });
}
