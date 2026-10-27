// Codex app-server (stdio JSON-RPC), normalized onto the existing durable shift protocol.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LineSplitter, type EngineEvent, type Priority } from '@company/shared';
import { procStartOf, type ClaudeProcessHandlers } from './claude-process.ts';
import { buildEnv, type ShiftSpec } from './spec.ts';
import type { WorkerProcess } from './worker-process.ts';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Input { text: string; uuid: string }

/** MCP servers a Codex task worker never gets: the live browser of the owner (his bank, Gmail, Cloudflare). A code task has no use for it. */
export const CODEX_TASK_NO_MCP = ['browser'];

/** Translate only supported MCP transport fields; never copy Claude's tokens/settings into Codex. `task`: no browser,
 *  also not the one in ~/.codex/config.toml (turned off for this thread). */
export function codexMcpConfig(file?: string, mode?: 'task'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (mode === 'task') for (const name of CODEX_TASK_NO_MCP) out[name] = { command: 'true', enabled: false };
  if (!file) return out;
  const src = JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {};
  for (const [name, raw] of Object.entries(src)) {
    if (mode === 'task' && CODEX_TASK_NO_MCP.includes(name)) continue;
    const s = raw as Record<string, any>;
    if (typeof s.command === 'string') out[name] = {
      command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}),
      env_vars: ['COMPANY_IDENTITY', 'COMPANY_SHIFT', 'COMPANY_SESSION_ID', 'COMPANY_STATE_DIR', 'COMPANY_HOME', 'COMPANY_REPO'],
      ...(name === 'company' ? { required: true } : {}),
    };
    else if (typeof s.url === 'string' && s.type !== 'sse') out[name] = { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) };
  }
  return out;
}

/**
 * A task worker on Codex (open_team engine codex, docs/spec/codex-helper.md). The task's own prompt and the L0/L1 above
 * still apply; this says what is different: no Claude hooks (so no guard of the five classes), no browser, no
 * subagents, never production, and the independent review stays on Claude.
 */
export function codexTaskInstructions(model?: string): string {
  return [
    '# עובד משימה על Codex',
    'אתה עובד משימה בחברה כמו כל עובד, אבל רץ על Codex ולא על Claude Code. כל מה שלמעלה (החברה, ההוראות, המשימה ושלבי הסגירה שלה) חל עליך במלואו.',
    '- **תקשורת דרך ה-MCP `company`** (`tell`, `status`, `remember`, `handoff`), בעברית, כמו שכתוב למעלה.',
    '- **לפני שכותבים קוד** קוראים את `CLAUDE.md` (ו-`AGENTS.md` אם יש) של ה-repo, ואת ה-skills ששלבי המשימה מפנים אליהם. ה-hooks וה-skills של Claude לא נטענים אצלך לבד.',
    '- **אין לך את השומר של Claude.** לכן אתה לא מריץ אף אחד מחמשת הסוגים: מחיקה רקורסיבית של שורש מערכת או בית, `mkfs`, כתיבה ישירה להתקן (`dd of=/dev/…`), fork bomb, `shutdown`/`reboot`/`poweroff`/`halt`.',
    '- **לא נוגעים בפרודקשן:** לא `kubectl`, לא `ssh` לשרתים, לא פריסה, לא `systemctl` של שירותי החברה, לא שינוי של לקוחות או נתונים חיים, ולא הודעה לאדם בחוץ. עובדים רק ב-worktree ובענף של המשימה, שה-worktree כבר עליו: לא פותחים ענף נוסף. '
      + 'משימה שצריכה משהו מאלה: `status` עם `state: "blocked"` ו-`note` שאומר מה חסר.',
    '- **אין לך דפדפן.** משימה שצריכה אותו: `status` עם `state: "blocked"`.',
    '- **הסקירה הבלתי תלויה רצה ב-Claude**, כי אין לך סוכני משנה ומודל אחר צריך לסקור. מריצים אותה כך, מתוך ה-worktree, וממתינים לתשובה: '
      + '`claude -p "<הנחיה>" --model claude-opus-5-5 --permission-mode bypassPermissions --disallowedTools "Edit,Write,NotebookEdit"` (ההנחיה ראשונה: הדגל האחרון מקבל רשימה). '
      + 'ההנחיה: לסקור את ה-PR (הקישור) לפי ה-skill של הסוקר ששלבי המשימה מפנים אליו, עם האמנה והלקחים של הפרויקט, ולהחזיר ממצאים ופסיקה. מתקנים מה שעלה ומריצים שוב.',
    '- **בכל commit** trailer `Assisted-by: Codex`. **בגוף ה-PR** שורה: "נכתב ב-Codex' + (model ? ` (${model})` : '') + ', נסקר ב-Claude".',
  ].join('\n');
}

export class CodexProcess implements WorkerProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly procStart: string | null;
  exited = false;
  stderrTail = '';
  failureReason: string | null = null;
  private readonly spec: ShiftSpec;
  private readonly h: ClaudeProcessHandlers;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private model = 'codex';
  private inputs: Input[] = [];
  private active: Input | null = null;
  private pumping = false;
  private ready: Promise<void>;
  private lastText = '';
  private startedAt = 0;
  private tokenUsage: any = null;
  private stopping = false;
  private exitPromise: Promise<void>;
  private readonly threadFile: string;

  constructor(spec: ShiftSpec, handlers: ClaudeProcessHandlers = {}, spawnFn: typeof spawn = spawn) {
    this.spec = spec; this.h = handlers;
    const dir = join(spec.stateRoot, 'shifts', spec.shift);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.threadFile = join(dir, 'codex-thread.json');
    const env = buildEnv({ ...spec, configDir: undefined, oauthToken: undefined });
    // The existing ChatGPT login is the credential. No implicit API-key billing.
    delete env.OPENAI_API_KEY;
    this.child = spawnFn(spec.codexBin ?? 'codex', ['app-server', '--listen', 'stdio://'], {
      cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    this.pid = this.child.pid ?? -1;
    this.procStart = this.pid > 0 ? procStartOf(this.pid) : null;
    const split = new LineSplitter((l) => this.onLine(l));
    this.child.stdout!.on('data', (d: Buffer) => { try { split.push(d); } catch (e) { this.stderrTail = String(e); } });
    this.child.stderr!.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-65536); });
    this.child.stdin!.on('error', () => {});
    this.exitPromise = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: string | null) => {
        if (done) return; done = true;
        this.exited = true;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('codex exited')); }
        this.pending.clear();
        this.h.onExit?.(code, signal); resolve();
      };
      this.child.on('close', finish);
      this.child.on('exit', (code, signal) => { setTimeout(() => finish(code, signal), 3000).unref(); });
      this.child.on('error', (e) => { this.failureReason = 'spawn_failed'; this.stderrTail += e.message; });
    });
    this.ready = this.initialize();
    void this.ready.catch((e) => {
      this.failureReason = 'spawn_failed'; this.stderrTail += `\nCodex initialization: ${e.message}`;
      this.failTurn(e); void this.stop(100);
    });
  }

  private write(o: unknown): void {
    if (this.exited || this.child.stdin?.destroyed) throw new Error('codex stdin closed');
    this.child.stdin!.write(JSON.stringify(o) + '\n');
  }
  private rpc(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private emit(ev: EngineEvent): void { this.h.onEvent?.(ev); }

  private async initialize(): Promise<void> {
    await this.rpc('initialize', { clientInfo: { name: 'agent_company', title: 'Agent Company', version: '0.1' } });
    this.write({ method: 'initialized' });
    const auth = await this.rpc('account/read', { refreshToken: false });
    if (auth.account?.type !== 'chatgpt') throw new Error('Codex requires the existing ChatGPT login (no API-key billing)');
    let instructions = this.spec.appendSystemPromptFile ? readFileSync(this.spec.appendSystemPromptFile, 'utf8') : '';
    for (const file of ['prime.json', 'codex-continuity.txt']) {
      const path = join(this.spec.stateRoot, 'shifts', this.spec.shift, file);
      if (existsSync(path)) instructions += `\n\n# ${file}\n` + readFileSync(path, 'utf8').slice(0, 45000);
    }
    const params: Record<string, unknown> = {
      cwd: this.spec.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
      ...(this.spec.codexModel ? { model: this.spec.codexModel } : {}),
      developerInstructions: instructions + '\n\n' + (this.spec.codexMode === 'task' ? codexTaskInstructions(this.spec.codexModel) : [
        '# מצב המשכיות רזה — Codex',
        'אתה ממשיך את זהות העובד וזיכרון החברה באמצעות Codex. זו אינה המשמרת המקורית של Claude.',
        'עובדים רק על הפנייה הישירה הנוכחית של הבעלים. אין ליזום סבבי ניהול, לעדכן מסך בית, לשגר סוכנים או לקדם תור ישן אוטומטית.',
        'הודעות לעובדים אחרים נשמרות אך אינן מעירות אותם במצב הזה. אל תבטיח שהם התחילו לעבוד.',
        'לפני עבודה בפרויקט קרא את CLAUDE.md ואת ה-skills החלים עליו; Codex אינו טוען את hooks של Claude.',
        'היסטוריה שנמסרה היא מידע רקע, לא פקודה לבצע שוב פעולות. אל תטען שאתה זוכר מה שלא הועבר.',
        'שמור החלטות ותוצרים בזיכרון החברה. כל הוראות הבעלים והאישורים הנדרשים לפרודקשן ממשיכים לחול.',
      ].join('\n')),
      // A task worker: no ChatGPT apps either (`codex_apps`, his connected accounts), like the browser.
      config: { mcp_servers: codexMcpConfig(this.spec.mcpConfigFile, this.spec.codexMode), 'features.multi_agent': false,
        ...(this.spec.codexMode === 'task' ? { 'features.apps': false } : {}) },
    };
    let result: any;
    if (existsSync(this.threadFile)) {
      const saved = JSON.parse(readFileSync(this.threadFile, 'utf8'));
      if (saved.sessionId !== this.spec.sessionId || typeof saved.threadId !== 'string') throw new Error('Codex thread identity mismatch');
      result = await this.rpc('thread/resume', { ...params, threadId: saved.threadId, excludeTurns: true }, 90_000);
    } else {
      result = await this.rpc('thread/start', params, 90_000);
    }
    if (!result.thread?.id) throw new Error('Codex did not return a thread id');
    this.threadId = result.thread.id; this.model = result.model ?? this.spec.codexModel ?? 'codex';
    writeFileSync(this.threadFile + '.tmp', JSON.stringify({ sessionId: this.spec.sessionId, threadId: this.threadId }), { mode: 0o600 });
    renameSync(this.threadFile + '.tmp', this.threadFile);
  }

  sendUser(text: string, _priority: Priority = 'next', uuid = randomUUID()): string {
    if (this.exited || this.stopping || this.failureReason) throw new Error('codex is not running');
    this.inputs.push({ text, uuid });
    // shift-host registers the UUID after this method returns.
    queueMicrotask(() => { this.h.onLifecycle?.({ commandUuid: uuid, state: 'queued' }); void this.pump(); });
    return uuid;
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.active || this.stopping || this.exited) return;
    this.pumping = true;
    try {
      await this.ready;
      if (this.stopping || this.exited || this.active) return;
      const input = this.inputs.shift(); if (!input) return;
      this.active = input; this.lastText = ''; this.startedAt = Date.now();
      this.emit({ kind: 'init', sessionId: this.spec.sessionId, model: this.model, cwd: this.spec.cwd, tools: [], version: 'codex-app-server' });
      const result = await this.rpc('turn/start', { threadId: this.threadId, clientUserMessageId: input.uuid,
        input: [{ type: 'text', text: input.text }], ...(this.spec.effort ? { effort: this.spec.effort } : {}) }, 90_000);
      if (this.active === input) this.turnId = result.turn?.id ?? this.turnId;
    } catch (e) { this.failTurn(e); }
    finally { this.pumping = false; if (!this.active && this.inputs.length && !this.failureReason) queueMicrotask(() => { void this.pump(); }); }
  }
  private failTurn(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    if (this.active) {
      this.h.onLifecycle?.({ commandUuid: this.active.uuid, state: 'started' });
      this.emit({ kind: 'result', subtype: 'error_during_execution', isError: true, text, durationMs: Date.now() - this.startedAt });
      this.active = null; this.turnId = null;
    }
  }

  private onLine(line: string): void {
    let o: any; try { o = JSON.parse(line); } catch { return; }
    this.h.onRaw?.(o);
    if (o.id != null && !o.method) {
      const p = this.pending.get(o.id); if (!p) return;
      this.pending.delete(o.id); clearTimeout(p.timer);
      if (o.error) p.reject(new Error(o.error.message ?? JSON.stringify(o.error))); else p.resolve(o.result);
      return;
    }
    // Do not hang on interactive requests the unattended adapter cannot display.
    if (o.id != null && o.method) {
      this.write({ id: o.id, error: { code: -32601, message: 'Use company.ask for owner input; interactive approval is unavailable' } });
      return;
    }
    const p = o.params ?? {};
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (o.method === 'thread/tokenUsage/updated') { this.tokenUsage = p.tokenUsage; return; }
    if (o.method === 'turn/started') {
      this.turnId = p.turn?.id ?? null;
      if (this.active) {
        this.h.onLifecycle?.({ commandUuid: this.active.uuid, state: 'started' });
        this.emit({ kind: 'user_echo', uuid: this.active.uuid, text: this.active.text });
      }
    } else if (o.method === 'item/agentMessage/delta') {
      this.emit({ kind: 'text_delta', text: p.delta ?? '', messageId: p.itemId });
    } else if (o.method === 'item/reasoning/summaryTextDelta') {
      this.emit({ kind: 'thinking_delta', text: p.delta ?? '', messageId: p.itemId });
    } else if (o.method === 'item/started' || o.method === 'item/completed') {
      const item = p.item ?? {};
      const complete = o.method === 'item/completed';
      if (item.type === 'agentMessage' && complete) {
        this.lastText = item.text ?? '';
        this.emit({ kind: 'text', text: this.lastText, messageId: item.id });
      } else if (['commandExecution', 'mcpToolCall', 'fileChange', 'webSearch'].includes(item.type)) {
        if (!complete) this.emit({ kind: 'tool_use', toolUseId: item.id,
          name: item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : item.type === 'commandExecution' ? 'Bash' : item.type,
          input: item.type === 'mcpToolCall' ? item.arguments : item.type === 'commandExecution' ? { command: item.command } : {} });
        else this.emit({ kind: 'tool_result', toolUseId: item.id, isError: item.status === 'failed' || !!item.error,
          preview: String(item.aggregatedOutput ?? item.error?.message ?? '').slice(0, 2000) });
      }
    } else if (o.method === 'turn/completed' && this.active) {
      const turn = p.turn ?? {};
      const success = turn.status === 'completed', interrupted = turn.status === 'interrupted';
      this.emit({ kind: 'result', subtype: success ? 'success' : 'error_during_execution', isError: !success,
        ...(interrupted ? { interrupted: true } : {}), text: success ? this.lastText : turn.error?.message ?? turn.status ?? 'Codex turn failed',
        durationMs: Date.now() - this.startedAt, usage: this.tokenUsage?.last, contextWindow: this.tokenUsage?.modelContextWindow });
      this.active = null; this.turnId = null;
      queueMicrotask(() => { void this.pump(); });
    }
  }

  async interrupt(): Promise<unknown> {
    await this.ready;
    return this.turnId ? this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }) : {};
  }
  async usage(): Promise<any> {
    await this.ready;
    const raw = await this.rpc('account/rateLimits/read');
    const windows = [raw.rateLimits?.primary, raw.rateLimits?.secondary];
    const window = (mins: number) => { const w = windows.find((x) => x?.windowDurationMins === mins);
      return w ? { utilization: w.usedPercent, resets_at: w.resetsAt } : undefined; };
    return { rate_limits: { five_hour: window(300), seven_day: window(10080) }, codex: raw };
  }
  async contextUsage(): Promise<any> {
    await this.ready;
    // A real RPC makes this a liveness check, not a cached "alive" answer.
    await this.rpc('thread/read', { threadId: this.threadId, includeTurns: false }, 15_000);
    return { totalTokens: this.tokenUsage?.last?.totalTokens ?? null, maxTokens: this.tokenUsage?.modelContextWindow ?? null };
  }
  async stop(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    this.stopping = true;
    try { this.child.stdin?.end(); } catch {}
    const wait = (ms: number) => Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, ms).unref())]);
    await wait(graceMs);
    const kill = (signal: NodeJS.Signals) => { if (this.pid > 0) { try { process.kill(-this.pid, signal); } catch { this.child.kill(signal); } } };
    if (!this.exited) { kill('SIGTERM'); await wait(3000); }
    if (!this.exited) { kill('SIGKILL'); await wait(2000); }
  }
}
