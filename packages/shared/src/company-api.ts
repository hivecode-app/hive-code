// mcp-company / hooks -> hq ingest API (B.5 "nothing in a turn depends on hq").
// Owner: engine lane (client side). hq implements the server side.
//
// Transport: HTTP/1.1 over the unix socket <stateRoot>/hq.sock, or the URL in
// COMPANY_HQ_URL (http://host:port) when set. JSON bodies, UTF-8.
//
//   POST /v1/ops      body: WalEntry        -> 200 OpAck
//     Idempotent on WalEntry.id: hq must accept a replay of an id it already
//     stored and answer with the same ack. 4xx = permanent reject (the client
//     marks the entry failed and stops retrying); 5xx / network = retry.
//   POST /v1/recall   body: RecallRequest   -> 200 RecallResponse
//     Read-only. The client gives up after 3s and falls back to grepping the
//     memory/ files of the company repo, marking the answer partial.

import type { IdentityId, ShiftId } from './index.ts';

export const COMPANY_API_VERSION = 1 as const;

export type OpName =
  | 'tell' | 'ask' | 'remember' | 'handoff' | 'status'
  | 'open_team' | 'close_team' | 'request_go' | 'open_ticket';

export interface WalEntry {
  id: string;              // `${shift}:${ulid-ish}`, unique, idempotency key
  v: number;               // COMPANY_API_VERSION
  ts: string;              // ISO, when the worker called the tool
  identity: IdentityId;
  shift: ShiftId;
  sessionId: string | null;
  op: OpName;
  args: Record<string, unknown>;
}

export interface OpAck {
  ok: true;
  id: string;
  /** Optional ids hq assigned, e.g. message id `m-8812` for tell/ask. */
  ref?: string;
  result?: unknown;
}

export interface RecallRequest {
  identity: IdentityId;
  shift: ShiftId;
  query: string;
  scope?: string;          // company | project:<p> | personal:<domain> | archive
  limit?: number;
}

export interface RecallItem {
  ref: string;             // e.g. dir-0142, memory/projects/lumo/x.md
  scope: string;
  title?: string;
  text: string;            // snippet
  score?: number;
}

export interface RecallResponse {
  items: RecallItem[];
  partial?: boolean;
}

/** Prime file the shift-host/hq writes before (re)starting a shift; read by
 *  the SessionStart hook (`company hook SessionStart`). Path: shiftDir/prime.json */
export interface PrimeFile {
  v: 1;
  shift: ShiftId;
  identity: IdentityId;
  updatedAt: string;
  handoff?: string;        // L2, budget 4000
  directives?: string;     // new directives since snapshot + L1 index, budget 2000
  /** Body of the single most relevant L3 record (bet 9: injecting the top body
   *  lifted answers-from-injection from 2/20 to 13/20), budget 1800. */
  topRecord?: string;
  memoryIndex?: string;    // short L3 index, budget 1000
  inbox?: string;          // unhandled messages digest, budget 1000
  pointers?: string;       // "details: recall dir-0142", budget 200
}

/** Sums to 10,000; the header line is cut by the hard cap. A compact_summary
 *  handoff must be cut to its <summary> and 4K (bet 1: raw it reaches 8K). */
export const PRIME_BUDGETS = {
  handoff: 4000, directives: 2000, topRecord: 1800, memoryIndex: 1000, inbox: 1000, pointers: 200,
} as const;
export const ADDITIONAL_CONTEXT_CAP = 10_000;

/** One hook invocation as appended to shiftDir/spool/<YYYYMMDDHH>.ndjson */
export interface SpoolLine {
  ts: string;
  event: string;           // hook_event_name
  pid: number;
  payload: unknown;        // the hook's stdin JSON (or {raw} if unparseable)
}

/** Environment every shift child (hooks, mcp-company) receives. */
export const ENV = {
  identity: 'COMPANY_IDENTITY',
  shift: 'COMPANY_SHIFT',
  stateDir: 'COMPANY_STATE_DIR',   // root, default ~/.local/state/agent-company
  repo: 'COMPANY_REPO',            // company repo checkout (memory/ fallback)
  hqUrl: 'COMPANY_HQ_URL',
  sessionId: 'COMPANY_SESSION_ID',
} as const;
