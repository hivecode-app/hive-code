// Minimal MCP (JSON-RPC 2.0, newline-delimited over stdio) for the `company`
// server. Transport-free: feed it lines, it returns reply lines.
import { randomBytes } from 'node:crypto';
import { COMPANY_API_VERSION } from '@company/shared';
import type { OpName, WalEntry } from '@company/shared';
import type { RecallQuery, RecallResult } from './recall.ts';
import { hebrewProblem, TOOL_BY_NAME, TOOLS, validateArgs } from './tools.ts';
import type { ToolDef } from './tools.ts';
import type { Settled } from './wal.ts';

/** Ops answered with hq's verdict instead of {queued:true}: their rejection must reach the caller in the same turn (#69). */
const SYNC_OPS: ReadonlySet<OpName> = new Set(['open_team', 'compose_home']);

export const SERVER_NAME = 'company';
export const SERVER_VERSION = '0.1.0';
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18'];

export interface Ctx { identity: string; shift: string; sessionId: string | null }

export interface ServerDeps {
  ctx: Ctx;
  /** Durable append; must not return before the entry is on disk. */
  append: (entry: WalEntry) => void;
  /** Waits for hq to settle an appended entry (null on timeout). Used by ops whose rejection the caller must see now. */
  waitSettled?: (id: string, timeoutMs: number) => Promise<Settled | null>;
  /** How long a synchronous op waits for hq before answering {queued:true}. */
  syncTimeoutMs?: number;
  recall: (req: RecallQuery) => Promise<RecallResult>;
  /** request_access: hq answers in the same call (it may wait for the owner's card or for a job, up to ~100s). */
  access?: (req: Record<string, unknown>) => Promise<unknown>;
  /** resources: hq's read-only picture of the machines, as text. */
  resources?: () => Promise<string>;
  /** reserve / release: hq answers in the same call (reserve may wait for a place, up to ~100s). */
  lease?: (req: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
  log?: (msg: string) => void;
  /** tools/list: the catalogue with this company's names (buildTools). Default: TOOLS. */
  tools?: readonly ToolDef[];
}

type Id = string | number | null;
interface Req { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown }

const ok = (id: Id, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });
const err = (id: Id, code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

let seq = 0;
export function newEntryId(shift: string, now: Date): string {
  seq = (seq + 1) % 1296;
  return `${shift}:${now.getTime().toString(36)}-${seq.toString(36).padStart(2, '0')}${randomBytes(4).toString('hex')}`;
}

export function createServer(deps: ServerDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  async function callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    const def = typeof name === 'string' ? TOOL_BY_NAME.get(name) : undefined;
    if (!def) throw Object.assign(new Error(`unknown tool: ${String(name)}`), { rpcCode: -32602 });
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const invalid = validateArgs(def, args);
    if (invalid) return text(`invalid arguments: ${invalid}`, true);
    const english = hebrewProblem(def, args);
    if (english) return text(english, true);

    if (def.name === 'recall') {
      const queries = Array.isArray(args.queries) ? (args.queries as string[]).filter((q) => q.trim()) : [];
      const query = typeof args.query === 'string' && args.query.trim() ? args.query : queries[0];
      if (!query) return text('invalid arguments: pass query or queries (Hebrew + English phrasings)', true);
      const res = await deps.recall({
        identity: deps.ctx.identity, shift: deps.ctx.shift, query,
        ...(queries.length ? { queries } : {}),
        ...(typeof args.scope === 'string' ? { scope: args.scope } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      return text(res);
    }

    if (def.name === 'resources') {
      if (!deps.resources) return text('resources לא זמין בשרת ה-MCP הזה', true);
      try { return text(await deps.resources()); }
      catch (e) { return text(`resources נכשל: ${e instanceof Error ? e.message : String(e)}. hq לא ענה; אפשר לנסות שוב, ובינתיים ממשיכים כמו היום.`, true); }
    }

    if (def.name === 'request_access') {
      if (!deps.access) return text('request_access לא זמין בשרת ה-MCP הזה', true);
      if (!args.request && !args.cancel && (!args.resource || !Array.isArray(args.argv) || !args.argv.length)) return text('invalid arguments: pass resource and argv, or request/cancel', true);
      try {
        return text(await deps.access({ ...args, identity: deps.ctx.identity, shift: deps.ctx.shift }));
      } catch (e) {
        return text(`request_access נכשל: ${e instanceof Error ? e.message : String(e)}. ייתכן שהבקשה הגיעה ל-hq ורצה: אם יש לך מזהה acc-N מקריאה קודמת, בדוק אותו עם request; אחרת אפשר לנסות שוב. אם זה נמשך, status עם needs-local.`, true);
      }
    }

    if (def.name === 'reserve' || def.name === 'release') {
      if (!deps.lease) return text(`${def.name} לא זמין בשרת ה-MCP הזה`, true);
      if (def.name === 'reserve' && !args.class && !args.lease) return text('invalid arguments: pass class, or lease to go on with one', true);
      try {
        return text(await deps.lease({ ...args, op: def.name, identity: deps.ctx.identity, shift: deps.ctx.shift }));
      } catch (e) {
        return text(`${def.name} נכשל: ${e instanceof Error ? e.message : String(e)}. ייתכן שהבקשה הגיעה ל-hq: אם יש לך lease-N מקריאה קודמת, המשך איתו; אחרת אפשר לנסות שוב. אם hq לא עונה, ממשיכים בלי הזמנה, כמו לפני שהיה כלי כזה.`, true);
      }
    }

    const t = now();
    const entry: WalEntry = {
      id: newEntryId(deps.ctx.shift, t), v: COMPANY_API_VERSION, ts: t.toISOString(),
      identity: deps.ctx.identity, shift: deps.ctx.shift, sessionId: deps.ctx.sessionId,
      op: def.name as OpName, args,
    };
    try {
      deps.append(entry);
    } catch (e) {
      log(`wal append failed: ${e instanceof Error ? e.message : String(e)}`);
      return text(`לא נשמר: כתיבה ל-WAL נכשלה (WAL write failed): ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (SYNC_OPS.has(entry.op) && deps.waitSettled) {
      const r = await deps.waitSettled(entry.id, deps.syncTimeoutMs ?? 5000);
      if (r?.outcome === 'fail') {
        const b = (r.body ?? {}) as { reason?: unknown; error?: unknown };
        const why = typeof b.reason === 'string' ? b.reason : typeof b.error === 'string' ? b.error : `HTTP ${r.status}`;
        return text(`\`${entry.op}\` נדחה ב-hq: ${why}`, true);
      }
      if (r?.outcome === 'ack') {
        const b = (r.body ?? {}) as { ref?: unknown; result?: unknown };
        return text({ ok: true, id: entry.id, ...(b.ref !== undefined ? { ref: b.ref } : {}), ...(b.result !== undefined ? { result: b.result } : {}) });
      }
    }
    return text({ queued: true, id: entry.id });
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
      case 'ping': return {};
      case 'tools/list': return { tools: deps.tools ?? TOOLS };
      case 'tools/call': return callTool(params);
      default: throw Object.assign(new Error(`method not found: ${method}`), { rpcCode: -32601 });
    }
  }

  /** Handles one input line; returns the reply line or null (notification). */
  async function handle(line: string): Promise<string | null> {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return err(null, -32700, 'parse error'); }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return err(null, -32600, 'invalid request');
    const m = msg as Req;
    const hasId = 'id' in m && m.id !== undefined;
    const id: Id = hasId ? (m.id as Id) : null;
    if (typeof m.method !== 'string') {
      // A response to something we never send, or garbage; ignore responses.
      return hasId && !('result' in m || 'error' in m) ? err(id, -32600, 'invalid request') : null;
    }
    if (!hasId) return null; // notifications: notifications/initialized, cancelled, ...
    const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Record<string, unknown>;
    try {
      return ok(id, await dispatch(m.method, params));
    } catch (e) {
      const code = (e as { rpcCode?: number }).rpcCode ?? -32603;
      if (code === -32603) log(`internal error in ${m.method}: ${e instanceof Error ? e.stack : String(e)}`);
      return err(id, code, e instanceof Error ? e.message : String(e));
    }
  }

  return { handle };
}
