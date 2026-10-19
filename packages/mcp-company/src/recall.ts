// recall: ask hq (3s budget), else the local L3 index over memory/ (+ extra sources).
import type { RecallItem, RecallRequest, RecallResponse } from '@company/shared';
import { openL3, renderFull, renderSnippet, scopeMatches, TOP_RECORD_BUDGET } from './l3.ts';
import type { L3Source } from './l3.ts';

export const RECALL_TIMEOUT_MS = 3000;
export const DEFAULT_RECALL_LIMIT = 8;
export const FALLBACK_NOTE = 'hq לא זמין; התוצאות מאינדקס מקומי של memory/ ועשויות להיות חלקיות (hq unreachable, local fallback).';

/** RecallRequest plus he/en reformulations; hq gets every query, `query` stays the first one. */
export interface RecallQuery extends RecallRequest { queries?: string[] }

export type RecallTransport = (req: RecallQuery, timeoutMs: number) => Promise<{ status: number; body: unknown }>;

export interface RecallResult extends RecallResponse { note?: string }

export interface RecallDeps {
  transport: RecallTransport;
  repo: string;
  stateRoot?: string;
  extraSources?: L3Source[];
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export async function recall(req: RecallQuery, deps: RecallDeps): Promise<RecallResult> {
  const limit = req.limit ?? DEFAULT_RECALL_LIMIT;
  const queries = [...new Set([req.query, ...(req.queries ?? [])].map((q) => (q ?? '').trim()).filter(Boolean))];
  try {
    const r = await deps.transport({ ...req, query: queries[0] ?? '', queries, limit }, deps.timeoutMs ?? RECALL_TIMEOUT_MS);
    const body = r.body as RecallResponse | null;
    if (r.status >= 200 && r.status < 300 && body && Array.isArray(body.items)) return body;
    deps.log?.(`recall: hq answered ${r.status}; using local fallback`);
  } catch (e) {
    deps.log?.(`recall: hq failed (${e instanceof Error ? e.message : String(e)}); using local fallback`);
  }
  const opts = { ...(deps.stateRoot ? { stateRoot: deps.stateRoot } : {}), ...(deps.extraSources ? { extraSources: deps.extraSources } : {}) };
  return { items: localRecall(deps.repo, queries, req.scope, limit, opts), partial: true, note: FALLBACK_NOTE };
}

/** memory/company/x.md -> company; memory/projects/lumo/x.md -> project:lumo;
 *  memory/personal/<domain>/x.md -> personal:<domain>; else the first dir. */
export function scopeOf(relPath: string): string {
  const parts = relPath.split('/');
  const [, top, second] = parts;
  if (!top || parts.length < 3) return 'company';
  if ((top === 'projects' || top === 'project') && second && parts.length > 3) return `project:${second}`;
  if (top === 'personal' && second && parts.length > 3) return `personal:${second}`;
  return top;
}

export interface LocalRecallOptions { stateRoot?: string; extraSources?: L3Source[] }

/** L3 BM25 over <repo>/memory/** + extra sources (COMPANY_L3_EXTRA_SOURCES). The top
 *  item carries the full record (<=1800 chars), the rest a snippet. An exact id wins. */
export function localRecall(repo: string, queries: readonly string[], scope: string | undefined, limit: number,
  opts: LocalRecallOptions = {}): RecallItem[] {
  const qs = queries.map((q) => q.trim()).filter(Boolean);
  if (!qs.length) return [];
  const idx = openL3({ repo, ...(opts.stateRoot ? { stateRoot: opts.stateRoot } : {}), ...(opts.extraSources ? { extraSources: opts.extraSources } : {}) });
  const hits = idx.search(qs, { limit, ...(scope ? { scope } : {}) });
  const exact = qs.map((q) => idx.get(q)).find((r) => r && (!scope || scopeMatches(r.scope, scope)));
  const ranked = exact ? [{ record: exact, score: hits[0]?.score ?? 1 }, ...hits.filter((h) => h.record.id !== exact.id)] : hits;
  return ranked.slice(0, limit).map((h, i) => ({
    ref: h.record.id, scope: h.record.scope, title: h.record.name,
    text: i === 0 ? renderFull(h.record, TOP_RECORD_BUDGET) : renderSnippet(h.record),
    score: Math.round(h.score * 1000) / 1000,
  }));
}
