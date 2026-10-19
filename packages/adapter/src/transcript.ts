// Tolerant, read-only transcript reader (research/05 §1.2, §8). Never writes.
// Unknown record types are counted, malformed lines are skipped and counted.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const KNOWN_RECORD_TYPES = new Set([
  'user', 'assistant', 'system', 'attachment', 'queue-operation', 'last-prompt', 'atis-latch', 'mode',
  'bridge-session', 'permission-mode', 'ai-title', 'pr-link', 'cost-state', 'file-history-snapshot',
  'frame-link', 'history-suppression', 'file-history-delta', 'summary', 'custom-title', 'tag',
  // seen on 2.1.303 (per-request system prompt/tools records, 2.1.300+)
  'api-request', 'api-request-shape', 'api-request-blob',
]);

export interface ArchiveMessage {
  uuid: string;
  parentUuid: string | null;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  isSidechain: boolean;
  isCompactSummary: boolean;
  isMeta: boolean;
  toolUses: string[];
}

export interface Archive {
  sessionId: string;
  path: string | null;
  records: number;
  badLines: number;
  typeCounts: Record<string, number>;
  unknownTypes: string[];
  messages: ArchiveMessage[];
  compactBoundaries: Array<{ uuid: string; trigger?: string; preTokens?: number; timestamp?: string }>;
  leafUuid: string | null;
  lastPrompt: string | null;
  attachmentsByType: Record<string, number>;
  /** paths from attachment.type=="instructions" (which CLAUDE.md files were loaded). */
  instructionFiles: string[];
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** queue-operation records (the CLI persists its own input queue, bet 2). */
  queueOps: Array<{ op: string; content?: string; timestamp?: string }>;
  /** Prompts of attachment.type=="queued_command" (mid-turn messages appear so, not as user). */
  queuedCommands: string[];
  /** In file order: enqueues and consumptions (user text / queued_command), for pendingQueued. */
  queueTimeline: Array<{ kind: 'enqueue' | 'consume'; text: string }>;
}

/** `text` occurs in `line` as whole lines (start/end or newline-bounded), not as a substring of a word. */
export function containsAsLines(line: string, text: string): boolean {
  if (!text) return false;
  let i = line.indexOf(text);
  while (i >= 0) {
    const before = i === 0 || line[i - 1] === '\n';
    const after = i + text.length === line.length || line[i + text.length] === '\n';
    if (before && after) return true;
    i = line.indexOf(text, i + 1);
  }
  return false;
}

/**
 * Messages the CLI enqueued but never consumed; on --resume it re-injects them
 * itself (merged into one user line with a NEW uuid). Matched by content, since
 * uuids do not survive (bet 2): an enqueue is consumed when a later user message
 * or queued_command contains its content.
 */
export function pendingQueued(a: Archive): string[] {
  // Walk in file order. Each consumption (a user line or queued_command) takes
  // the EARLIEST pending enqueues it carries: exact text, or whole-line segments
  // of a merged re-injected line. Each enqueue is consumed at most once, so two
  // identical "continue" messages stay two.
  const pending: string[] = [];
  for (const ev of a.queueTimeline) {
    if (ev.kind === 'enqueue') { pending.push(ev.text); continue; }
    const exact = pending.indexOf(ev.text);
    if (exact >= 0) { pending.splice(exact, 1); continue; }
    for (const i of consumeSegments(ev.text, pending).reverse()) pending.splice(i, 1);
  }
  return pending;
}

/**
 * Which of `candidates` (in order) a merged line carries: each candidate must
 * occur as whole lines, after the previous match, and each occurrence is used
 * once. Returns candidate indices, ascending. Used for the CLI's merged
 * re-injection on --resume (bet 2).
 */
export function consumeSegments(line: string, candidates: readonly string[]): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (let i = 0; i < candidates.length; i++) {
    const text = candidates[i]!;
    if (!text) continue;
    let at = line.indexOf(text, cursor);
    while (at >= 0) {
      const before = at === 0 || line[at - 1] === '\n';
      const after = at + text.length === line.length || line[at + text.length] === '\n';
      if (before && after) break;
      at = line.indexOf(text, at + 1);
    }
    if (at < 0) continue;
    out.push(i);
    cursor = at + text.length;
  }
  return out;
}

/** cwd -> project dir slug: every non-alphanumeric char becomes '-' (>200: truncated + hash). */
export function projectSlug(cwd: string): string {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (s.length <= 200) return s;
  return s.slice(0, 200) + '-' + createHash('sha256').update(cwd).digest('hex').slice(0, 8);
}

export function projectsDir(configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  return join(configDir, 'projects');
}

/** Finds <sessionId>.jsonl: first by cwd slug, then by scanning all project dirs. */
export function findTranscript(sessionId: string, opts: { cwd?: string; projects?: string } = {}): string | null {
  const root = opts.projects ?? projectsDir();
  if (opts.cwd) {
    const p = join(root, projectSlug(opts.cwd), `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
};

export function emptyArchive(sessionId: string, path: string | null): Archive {
  return { sessionId, path, records: 0, badLines: 0, typeCounts: {}, unknownTypes: [], messages: [],
    compactBoundaries: [], leafUuid: null, lastPrompt: null, attachmentsByType: {}, instructionFiles: [],
    firstTimestamp: null, lastTimestamp: null, queueOps: [], queuedCommands: [], queueTimeline: [] };
}

/** Feed one raw line into an archive (exported for tests and incremental tailers). */
export function ingestLine(a: Archive, line: string): void {
  if (!line.trim()) return;
  let r: any;
  try { r = JSON.parse(line); } catch { a.badLines++; return; }
  if (typeof r !== 'object' || r === null || typeof r.type !== 'string') { a.badLines++; return; }
  a.records++;
  const key = r.type === 'system' && r.subtype ? `system/${r.subtype}` : r.type;
  a.typeCounts[key] = (a.typeCounts[key] ?? 0) + 1;
  if (!KNOWN_RECORD_TYPES.has(r.type) && !a.unknownTypes.includes(r.type)) a.unknownTypes.push(r.type);
  if (typeof r.timestamp === 'string') {
    a.firstTimestamp ??= r.timestamp;
    a.lastTimestamp = r.timestamp;
  }
  switch (r.type) {
    case 'user':
    case 'assistant': {
      const c = r.message?.content;
      if (r.type === 'user') { const t = textOf(c); if (t) a.queueTimeline.push({ kind: 'consume', text: t }); }
      a.messages.push({
        uuid: r.uuid, parentUuid: r.parentUuid ?? null, role: r.type, text: textOf(c), timestamp: r.timestamp,
        isSidechain: r.isSidechain === true, isCompactSummary: r.isCompactSummary === true, isMeta: r.isMeta === true,
        toolUses: Array.isArray(c) ? c.filter((b: any) => b?.type === 'tool_use').map((b: any) => String(b.name)) : [],
      });
      break;
    }
    case 'system':
      if (r.subtype === 'compact_boundary') {
        const m = r.compactMetadata ?? {};
        a.compactBoundaries.push({ uuid: r.uuid, trigger: m.trigger, preTokens: m.preTokens, timestamp: r.timestamp });
      }
      break;
    case 'queue-operation':
      a.queueOps.push({ op: String(r.operation ?? ''), content: typeof r.content === 'string' ? r.content : undefined, timestamp: r.timestamp });
      if (r.operation === 'enqueue' && typeof r.content === 'string' && r.content) a.queueTimeline.push({ kind: 'enqueue', text: r.content });
      break;
    case 'last-prompt':
      a.leafUuid = r.leafUuid ?? a.leafUuid;
      a.lastPrompt = r.lastPrompt ?? a.lastPrompt;
      break;
    case 'attachment': {
      const t = r.attachment?.type ?? 'unknown';
      a.attachmentsByType[t] = (a.attachmentsByType[t] ?? 0) + 1;
      if (t === 'queued_command') {
        const pr = r.attachment.prompt ?? r.attachment.content;
        const txt = typeof pr === 'string' ? pr : Array.isArray(pr) ? pr.map((b: any) => b?.text ?? '').join('') : '';
        if (txt) { a.queuedCommands.push(txt); a.queueTimeline.push({ kind: 'consume', text: txt }); }
      }
      if (t === 'instructions' && Array.isArray(r.attachment.files)) {
        for (const f of r.attachment.files) if (f?.path && !a.instructionFiles.includes(f.path)) a.instructionFiles.push(f.path);
      }
      break;
    }
  }
}

export async function readTranscriptFile(path: string, sessionId = ''): Promise<Archive> {
  const a = emptyArchive(sessionId, path);
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) ingestLine(a, line);
  return a;
}

export async function readTranscript(sessionId: string, opts: { cwd?: string; projects?: string } = {}): Promise<Archive> {
  const p = findTranscript(sessionId, opts);
  if (!p) return emptyArchive(sessionId, null);
  return readTranscriptFile(p, sessionId);
}
