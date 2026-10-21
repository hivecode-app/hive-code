// `pr.merged` (the company map's merges): a PR a worker merged, as hq's own event, so the day's merges come from
// hq.db and not from GitHub. A merge is read off the worker's hook spool: a PostToolUse `gh pr merge` (or the
// `gh api …/pulls/<n>/merge` form) whose output says it merged. Only a merge that happened is recorded:
// `--auto` and a refused merge print something else. One event per PR, whoever reports it first.
import type { Store } from './store.ts';

export interface PrMerged { repo: string | null; number: number; title: string | null; project: string | null; by: string | null }

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/** What the command merged: `gh pr merge [N|url|branch] [-R repo]`, or `gh api repos/o/r/pulls/N/merge`. */
function target(command: string): { repo: string | null; ref: string | null } | null {
  const api = /\bgh\s+api\b[^\n;&|]*?\/?repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge/.exec(command);
  if (api) return { repo: api[1]!, ref: api[2]! };
  const m = /\bgh\s+pr\s+merge\b([^\n;&|]*)/.exec(command);
  if (!m) return null;
  const words = m[1]!.trim().split(/\s+/).filter((w) => w && !ASSIGN.test(w));
  let repo: string | null = null;
  let ref: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const flag = /^(?:--repo|-R)(?:=(.+))?$/.exec(w);
    if (flag) { repo = flag[1] ?? words[++i] ?? null; continue; }
    if (w.startsWith('-')) continue;
    const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(w);
    if (url) { repo = url[1]!; ref = url[2]!; } else ref ??= w;
  }
  return { repo, ref };
}

/** The text of a tool's answer, whichever shape the hook payload carries it in. */
function outputOf(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';
  const r = resp as { stdout?: unknown; output?: unknown; content?: unknown };
  return [r.stdout, r.output, typeof r.content === 'string' ? r.content : ''].filter((x) => typeof x === 'string').join('\n');
}

/** The merge a PostToolUse hook payload reports, or null when it reports none (not a merge, or it did not merge). */
export function prMergedFrom(payload: unknown): Omit<PrMerged, 'project' | 'by'> | null {
  const p = (payload ?? {}) as { tool_name?: unknown; tool_input?: { command?: unknown }; tool_response?: unknown; cwd?: unknown };
  const command = p.tool_input?.command;
  if (p.tool_name !== 'Bash' || typeof command !== 'string' || !/\bgh\b/.test(command)) return null;
  const t = target(command);
  if (!t) return null;
  const out = outputOf(p.tool_response);
  // gh: "✓ Squashed and merged pull request #226 (title)" · the API: {"merged":true,…}
  const said = /\bmerged pull request (?:([^\s#]+\/[^\s#]+))?#(\d+)(?:\s+\((.*)\))?/i.exec(out);
  const api = /"merged"\s*:\s*true/.test(out);
  if (!said && !api) return null;
  const number = said ? Number(said[2]) : /^\d+$/.test(t.ref ?? '') ? Number(t.ref) : NaN;
  if (!Number.isInteger(number) || number <= 0) return null;
  // Without --repo, the repo is the checkout's: a task worktree is <repo>/.worktrees/<task>.
  const cwd = typeof p.cwd === 'string' ? /([^/]+)\/\.worktrees\//.exec(p.cwd)?.[1] : undefined;
  return { repo: said?.[1] ?? t.repo ?? cwd ?? null, number, title: said?.[3]?.trim() || null };
}

/** A repo by its name: the spool knows "agent-company", a POST "hivecode-app/hive-code". */
const repoName = (r: string | null): string => (r ?? '').split('/').pop() ?? '';

/** Records [m] once per repo and number; false when the event already exists. */
export function recordPrMerged(store: Store, m: PrMerged): boolean {
  const rows = store.db.prepare(`SELECT json_extract(data, '$.repo') repo FROM events WHERE type = 'pr.merged' AND json_extract(data, '$.number') = ?`).all(m.number) as { repo: string | null }[];
  if (rows.some((r) => repoName(r.repo) === repoName(m.repo))) return false;
  store.emit('pr.merged', m.by, m);
  return true;
}
