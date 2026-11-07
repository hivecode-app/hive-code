// Task 1476: "מחכה לפריסה" clears by what production runs, not by who remembered to say so. A charter's `live:` names
// each part of the project that runs in production and a command that prints the commit(s) it runs (LivePart). hq
// reads them every LIVE_EVERY_MS (30 minutes: a round of ssh and GitHub calls takes minutes), keeps the answer in live_parts, and clears `deploy` on every task whose merged PR is
// in every part it needs: the PR's merge commit is an ancestor of each commit that part runs (GitHub's compare).
//
// Before this, only a deploy report naming a task or its PR cleared it (awaiting.deployed). Six of the seven projects
// that had tasks waiting never reported (their deploys are a kubectl, a GitOps promote, a store release), and the
// reports that came named some of what they shipped. A report still clears what it names; this clears the rest.
//
// What stays: a PR not merged, a part whose command failed or printed nothing (unknown is not live), a PR that needs
// a part that doesn't run it yet (a canary, a component not redeployed), a PR whose files match no part (hq can't tell
// what would deploy it), a task with no PR or with a PR whose repo isn't known, and a project with no `live:`.
//
// A part no command can read (a store release) is `sha: report`: it runs what the last deploy report with `target` =
// its name said (POST /api/deploys), so a PR that also changes the app waits for the release, not only for the server.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import type { AwaitingBoard } from './awaiting.ts';
import type { Store } from './store.ts';
import type { LivePart } from './workspace.ts';

export const LIVE_EVERY_MS = 30 * 60_000;
/** One part's command: an ssh to a cluster and a kubectl, at most. */
const CMD_TIMEOUT_MS = 90_000;

/** What hq needs from GitHub, one call each (tests replace it). */
export interface LiveGit {
  /** A PR: merged or not, its merge commit, and the files it changed. */
  pr(repo: string, n: string): Promise<{ merged: boolean; sha: string | null; files: string[] }>;
  /** Is `ancestor` in the history of `tip` (or the same commit)? */
  contains(repo: string, ancestor: string, tip: string): Promise<boolean>;
}

/** Runs a part's command; its stdout, or throws. */
export type LiveRun = (cmd: string) => Promise<string>;

export type LiveVerdict =
  | { id: number; live: true; parts: string[] }
  | { id: number; live: false; why: 'no-pr' | 'no-repo' | 'not-merged' | 'no-part' | 'unknown' | 'behind' | 'error'; parts?: string[]; detail?: string };

/** Every commit-looking word a command printed (7 to 40 hex), in order, once each. */
export function shasOf(out: string): string[] {
  // At least one letter: a 7+ digit number (a timestamp, a build number) is not a commit.
  return [...new Set([...out.matchAll(/\b(?=[0-9]*[a-f])[0-9a-f]{7,40}\b/g)].map((m) => m[0]))];
}

/** The parts of `repo` a PR with these files needs: a part with no paths takes every file; else a prefix match. */
export function partsFor(parts: LivePart[], repo: string, files: string[]): LivePart[] {
  const mine = parts.filter((p) => p.repo.toLowerCase() === repo.toLowerCase());
  return mine.filter((p) => !p.paths || files.some((f) => p.paths!.some((x) => f === x || f.startsWith(x.endsWith('/') ? x : `${x}/`))));
}

const run = (cmd: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, cwd: homedir(), env },
    (err, out, stderr) => (err ? reject(new Error((String(stderr) || err.message).trim().slice(0, 300))) : resolve(String(out)))));

/** A part's command, from $HOME, with COMPANY_DIR = the company's `company/` (its scripts live in company/live/). */
export const shellRun = (companyDir: string): LiveRun => (cmd) => run('bash', ['-c', cmd], CMD_TIMEOUT_MS, { ...process.env, COMPANY_DIR: companyDir });

/** GitHub through `gh` (hq's own login). Merged PRs and ancestry never change, so callers may cache them. */
export const ghLiveGit: LiveGit = {
  async pr(repo, n) {
    const head = JSON.parse(await run('gh', ['api', `repos/${repo}/pulls/${n}`, '--jq', '{merged: .merged, sha: .merge_commit_sha}'], 30_000)) as { merged: boolean; sha: string | null };
    if (!head.merged) return { merged: false, sha: null, files: [] };
    const files = (await run('gh', ['api', '--paginate', `repos/${repo}/pulls/${n}/files?per_page=100`, '--jq', '.[].filename'], 60_000)).split('\n').filter(Boolean);
    return { merged: true, sha: head.sha, files };
  },
  async contains(repo, ancestor, tip) {
    // compare base...head: "ahead" = head has base in its history; "identical" = the same commit.
    const status = (await run('gh', ['api', `repos/${repo}/compare/${ancestor}...${tip}`, '--jq', '.status'], 30_000)).trim();
    return status === 'ahead' || status === 'identical';
  },
};

export class LiveWatch {
  private store: Store;
  private awaiting: AwaitingBoard;
  private partsOf: (project: string) => LivePart[];
  private git: LiveGit;
  private runCmd: LiveRun;
  /** Merged PRs (they don't change) and ancestry answers (neither do they). */
  private prs = new Map<string, { merged: boolean; sha: string | null; files: string[] }>();
  private contained = new Map<string, boolean>();
  /** The last answer per waiting task, for GET /api/deploys/live. */
  readonly verdicts = new Map<number, LiveVerdict>();

  constructor(store: Store, awaiting: AwaitingBoard, partsOf: (project: string) => LivePart[], deps: { git?: LiveGit; run?: LiveRun; companyDir?: string } = {}) {
    this.store = store; this.awaiting = awaiting; this.partsOf = partsOf;
    this.git = deps.git ?? ghLiveGit; this.runCmd = deps.run ?? shellRun(deps.companyDir ?? '');
  }

  /** One round at a time: the first tick, the timer and a deploy report's refresh never run the same commands at once. */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Every project with a task that waits on a deploy: read its parts, then clear what they run. Returns the ids cleared. */
  tick(): Promise<number[]> { return this.serial(() => this.round()); }

  private async round(): Promise<number[]> {
    const projects = (this.store.db.prepare(`SELECT DISTINCT project FROM tasks WHERE awaiting = 'deploy' AND project IS NOT NULL`)
      .all() as { project: string }[]).map((r) => r.project);
    const cleared: number[] = [];
    for (const project of projects) {
      const parts = this.partsOf(project);
      if (!parts.length) continue;
      await this.read(project, parts);
      cleared.push(...await this.settle(project, parts));
    }
    return cleared;
  }

  /** One project now (a deploy report just came): read its parts, clear what they run. */
  refresh(project: string): Promise<number[]> {
    return this.serial(async () => {
      const parts = this.partsOf(project);
      if (!parts.length) return [];
      await this.read(project, parts);
      return this.settle(project, parts);
    });
  }

  /** Runs each part's command (or takes its last deploy report) and keeps what it printed (or why it is unknown). */
  async read(project: string, parts: LivePart[]): Promise<void> {
    for (const p of parts) {
      let shas: string[] = [], error: string | null = null;
      if (p.sha == null) {
        const r = this.store.db.prepare('SELECT sha FROM deploys WHERE project = ? AND target = ? ORDER BY id DESC LIMIT 1').get(project, p.part) as { sha: string } | undefined;
        shas = r ? shasOf(r.sha) : [];
        if (!shas.length) error = `אין דיווח פריסה עם target "${p.part}"`;
      } else try {
        shas = shasOf(await this.runCmd(p.sha));
        if (!shas.length) error = 'הפקודה לא החזירה commit';
      } catch (e) { error = (e as Error).message; }
      const was = this.store.db.prepare('SELECT error FROM live_parts WHERE project = ? AND part = ?').get(project, p.part) as { error: string | null } | undefined;
      this.store.db.prepare(`INSERT INTO live_parts (project, part, repo, shas, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (project, part) DO UPDATE SET repo = excluded.repo, shas = excluded.shas, error = excluded.error, checked_at = excluded.checked_at`)
        .run(project, p.part, p.repo, JSON.stringify(shas), error, this.store.now());
      // Once per change, not every round: a part that stays unknown is in live_parts (and GET /api/deploys/live).
      if (error && p.sha != null && was?.error !== error) this.store.emit('live.unknown', null, { project, part: p.part, error });
    }
  }

  /** What each part ran at the last read: commits, or [] when unknown. */
  liveShas(project: string): Map<string, string[]> {
    const rows = this.store.db.prepare('SELECT part, shas FROM live_parts WHERE project = ?').all(project) as { part: string; shas: string }[];
    return new Map(rows.map((r) => [r.part, JSON.parse(r.shas) as string[]]));
  }

  /** Clears `deploy` on each task of [project] whose PR every part it needs runs. Returns the ids cleared. */
  async settle(project: string, parts: LivePart[]): Promise<number[]> {
    const live = this.liveShas(project);
    const tasks = this.store.db.prepare(`SELECT id FROM tasks WHERE awaiting = 'deploy' AND project = ?`).all(project) as { id: number }[];
    const cleared: number[] = [];
    for (const { id } of tasks) {
      const v = await this.verdict(id, parts, live).catch((e: Error): LiveVerdict => ({ id, live: false, why: 'error', detail: e.message.slice(0, 200) }));
      this.verdicts.set(id, v);
      if (!v.live) continue;
      const by = `live:${v.parts.join(',')}`;
      if (this.awaiting.clear(id, by, 'deployed')) {
        cleared.push(id);
        this.store.emit('live.deployed', null, { id, project, parts: v.parts });
      }
    }
    for (const id of [...this.verdicts.keys()]) if (!this.awaiting.get(id)) this.verdicts.delete(id);
    return cleared;
  }

  private async verdict(id: number, parts: LivePart[], live: Map<string, string[]>): Promise<LiveVerdict> {
    const t = this.awaiting.get(id);
    if (!t?.pr) return { id, live: false, why: 'no-pr' };
    // pr_repo is set whenever it can be told (mark, backfillPrRepos; a project with one checkout always can). Null
    // means two repos could have this number: no guess, the task stays.
    const repo = t.pr_repo;
    if (!repo) return { id, live: false, why: 'no-repo' };
    const key = `${repo}#${t.pr}`;
    let pr = this.prs.get(key);
    if (!pr) {
      pr = await this.git.pr(repo, t.pr);
      if (pr.merged) this.prs.set(key, pr);
    }
    if (!pr.merged || !pr.sha) return { id, live: false, why: 'not-merged' };
    const need = partsFor(parts, repo, pr.files);
    if (!need.length) return { id, live: false, why: 'no-part' };
    const unknown = need.filter((p) => !(live.get(p.part)?.length));
    if (unknown.length) return { id, live: false, why: 'unknown', parts: unknown.map((p) => p.part) };
    const behind: string[] = [];
    for (const p of need) {
      for (const tip of live.get(p.part)!) {
        const k = `${repo}:${pr.sha}:${tip}`;
        let yes = this.contained.get(k);
        if (yes === undefined) { yes = await this.git.contains(repo, pr.sha, tip); this.contained.set(k, yes); }
        if (!yes) { behind.push(p.part); break; }
      }
    }
    return behind.length ? { id, live: false, why: 'behind', parts: behind } : { id, live: true, parts: need.map((p) => p.part) };
  }
}
