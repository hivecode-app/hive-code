// Where a project's workers run (B.5). The charter (company/projects/<p>.md) names the checkout(s) on
// a machine; hq creates one worktree per task there (`git worktree add -b`), runs the shift in it, and
// on close preserves anything uncommitted under refs/company/preserved/<task> before removing the
// worktree without --force.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { parseHeavy, type HeavyClass } from './heavy.ts';

export interface Checkout {
  name: string;
  path: string;           // absolute, ~ expanded
  defaultBranch: string;
  repo: string | null;    // GitHub owner/name
}

/**
 * `design_review` in a charter: a PR that touches `paths` also needs the approval of `reviewer` before the merge. If
 * the reviewer has not answered within `wait_minutes`, a PR under `small_lines` changed lines in those paths merges
 * without it, with a note on the PR.
 */
export interface DesignReview { reviewer: string; paths: string[]; waitMinutes: number; smallLines: number }

/** Never `default` (yet): a task goes to Codex only when whoever opens it asks (task 836). */
export interface CodexCharter { tasks: 'off' | 'on-request'; model: string | null }

/**
 * `live:` in a charter (task 1476): one part of the project that runs in production, and how hq reads what it runs.
 * `sha` is a shell command (from $HOME, with COMPANY_DIR set: the long ones are scripts in company/live/<project>/)
 * that prints the commit(s) the part runs now, one per line (every instance of a fleet: a
 * PR is live only when all of them contain it). `paths`: a PR needs this part only when it touches one of them
 * (prefixes); none = every file of the repo. hq clears "מחכה לפריסה" by itself once every part a PR needs runs it.
 * `sha: report` (sha null here): no command can tell (a store release); the part runs what the last deploy report with
 * `target` = its name said, and is unknown until one comes.
 */
export interface LivePart { part: string; repo: string; paths: string[] | null; sha: string | null }

export interface AccessGrant { resource: string; verbs: ('read' | 'write' | 'exec')[]; quote: string; date: string }

export interface Charter {
  project: string;
  status: string;         // active | dormant | …
  machine: string | null;
  checkouts: Checkout[];
  worktreeDir: string;    // relative to the checkout: <checkout>/<worktreeDir>/<task>
  commands: Record<string, string>;
  ciCheck: string | null;
  mergeInstructions: string[] | null; // merge_instructions (a string, or one string per step): replaces the default review + merge steps in a task worker's prompt
  designReview: DesignReview | null;  // design_review: a second review, by a designer, for a PR that touches these paths
  /** `access:` — his past words on request_access: a resource, the verb classes, his quote and the date (A.7). A prod read runs without it and a prod write asks with it; a matching one only records `auto:grant` and the quote. */
  access: AccessGrant[];
  /** `heavy:` — what is heavy in this project (reserve): classes that replace the company's of the same name (heavy.ts). */
  heavy: HeavyClass[];
  /** `codex:` — Codex as a task worker (codex-helper.md). `on-request`: an open_team with `engine: "codex"` runs on it. Off by default. */
  codex: CodexCharter;
  /** `live:` — what runs in production and how to read it (LivePart). Empty: hq can't tell, only a deploy report clears. */
  live: LivePart[];
  paused: string | null;  // paused: he put the project on hold (the reason, or "מושהה"). Workers still run; hq doesn't wake it (stall-watch.ts)
  error?: string;         // status "invalid": why the charter could not be read
}

/** No workers for this charter: dormant (not moved to the company yet) or unreadable. */
export const noWorkers = (ch: Charter | null) => ch?.status === 'dormant' || ch?.status === 'invalid';

const expand = (p: string) => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The GitHub repo a task's PR is in: the checkout its worktree lives in (<checkout>/<worktree_dir>/<name>), else the
 * charter's only checkout. Null when it can't be told (several checkouts, none matching): no link is better than one
 * to another repo's PR with the same number.
 */
export function repoOfWorktree(ch: Charter | null, worktree: string | null | undefined): string | null {
  if (!ch) return null;
  const hit = worktree ? ch.checkouts.find((c) => dirname(worktree) === join(c.path, ch.worktreeDir)) : undefined;
  if (hit) return hit.repo;
  return ch.checkouts.length === 1 ? ch.checkouts[0]!.repo : null;
}

/** The charter's frontmatter, or null when the project has no charter. Read fresh on every call. */
export function readCharter(companyDir: string, project: string): Charter | null {
  if (!SLUG.test(project)) return null;
  const file = join(companyDir, 'projects', `${project}.md`);
  if (!existsSync(file)) return null;
  let fm: Record<string, unknown>;
  // A broken charter must not throw into the scheduler or ingest (a 5xx there is retried forever).
  // check:contract keeps it valid in CI; here it reads as status "invalid": no workers, and the
  // scheduler reports it (charter.invalid).
  try {
    const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    fm = ((m ? parse(m[1]!) : {}) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { project, status: 'invalid', machine: null, checkouts: [], worktreeDir: '.worktrees', commands: {}, ciCheck: null, mergeInstructions: null, designReview: null, access: [], heavy: [], codex: { tasks: 'off', model: null }, live: [], paused: null, error: (e as Error).message };
  }
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const checkouts: Checkout[] = [];
  for (const c of Array.isArray(fm.checkouts) ? fm.checkouts : []) {
    const o = (c ?? {}) as Record<string, unknown>;
    const path = s(o.path);
    if (!path) continue;
    checkouts.push({ name: s(o.name) ?? project, path: expand(path), defaultBranch: s(o.default_branch) ?? 'main',
      repo: s(o.repo) ?? (checkouts.length === 0 ? s(fm.repo) : null) });
  }
  const commands: Record<string, string> = {};
  if (fm.commands && typeof fm.commands === 'object') for (const [k, v] of Object.entries(fm.commands)) if (s(v)) commands[k] = v as string;
  return {
    project, status: s(fm.status) ?? 'active', machine: s(fm.machine), checkouts,
    worktreeDir: s(fm.worktree_dir) ?? '.worktrees', commands, ciCheck: s(fm.ci_check),
    mergeInstructions: steps(fm.merge_instructions), designReview: designReview(fm.design_review), access: accessGrants(fm.access), heavy: parseHeavy(fm.heavy),
    codex: codexCharter(fm.codex), live: liveParts(fm.live, checkouts[0]?.repo ?? s(fm.repo)),
    paused: fm.paused === true ? 'מושהה' : s(fm.paused),
  };
}

/** Only a whole grant counts: a resource, a quote of his and a date. Verbs default to read. */
function accessGrants(v: unknown): AccessGrant[] {
  const s = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return (Array.isArray(v) ? v : []).flatMap((x): AccessGrant[] => {
    const o = (x ?? {}) as Record<string, unknown>;
    const resource = s(o.resource), quote = s(o.quote);
    const date = o.date instanceof Date ? o.date.toISOString().slice(0, 10) : s(o.date);
    if (!resource || !quote || !date) return [];
    const verbs = (Array.isArray(o.verbs) ? o.verbs : ['read']).filter((w): w is 'read' | 'write' | 'exec' => w === 'read' || w === 'write' || w === 'exec');
    return verbs.length ? [{ resource, verbs, quote, date }] : [];
  });
}

/** Only a whole part counts: a name, a repo (its own or the charter's) and a command (or `report`). */
export function liveParts(v: unknown, repo: string | null): LivePart[] {
  const s = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  return (Array.isArray(v) ? v : []).flatMap((x): LivePart[] => {
    const o = (x ?? {}) as Record<string, unknown>;
    const part = s(o.part), sha = s(o.sha), r = s(o.repo) ?? repo;
    if (!part || !sha || !r) return [];
    const paths = (Array.isArray(o.paths) ? o.paths : []).map(s).filter((p): p is string => !!p);
    return [{ part, repo: r, paths: paths.length ? paths : null, sha: sha === 'report' ? null : sha }];
  });
}

function codexCharter(v: unknown): CodexCharter {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { tasks: o.tasks === 'on-request' ? 'on-request' : 'off', model: typeof o.model === 'string' && o.model ? o.model : null };
}

function designReview(v: unknown): DesignReview | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const paths = (Array.isArray(o.paths) ? o.paths : []).filter((x): x is string => typeof x === 'string' && !!x);
  if (typeof o.reviewer !== 'string' || !o.reviewer || !paths.length) return null;
  const n = (x: unknown, d: number) => (typeof x === 'number' && x > 0 ? x : d);
  return { reviewer: o.reviewer, paths, waitMinutes: n(o.wait_minutes, 30), smallLines: n(o.small_lines, 50) };
}

/** A string or a list of strings → non-empty steps, or null. */
function steps(v: unknown): string[] | null {
  const out = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
  return out.length ? out : null;
}

/** hq's own commits (the preserved refs) need no user git config. */
const HQ_AUTHOR = {
  GIT_AUTHOR_NAME: 'agent-company hq', GIT_AUTHOR_EMAIL: 'hq@agent-company.invalid',
  GIT_COMMITTER_NAME: 'agent-company hq', GIT_COMMITTER_EMAIL: 'hq@agent-company.invalid',
};

export type Git =(cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

export const runGit: Git = (cwd, args, env) => new Promise((res, rej) => {
  execFile('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 16 << 20, timeout: 120_000 },
    (err, stdout, stderr) => (err ? rej(new Error(`git ${args.join(' ')} (in ${cwd}): ${String(stderr || err.message).trim().slice(0, 400)}`)) : res(String(stdout))));
});

/**
 * commands.worktree_setup of the charter: runs in a new worktree right after `git worktree add` (links to
 * untracked dirs of the main checkout, `flutter pub get`…), in `bash -c` with COMPANY_CHECKOUT = the checkout.
 */
export type Setup = (cwd: string, command: string, checkout: string, timeoutMs?: number) => Promise<void>;

export const runSetup: Setup = (cwd, command, checkout, timeoutMs = 15 * 60_000) => new Promise((res, rej) => {
  // Its own process group: a timeout kills the whole setup (flutter, dart…), not only bash.
  const p = spawn('bash', ['-c', command], { cwd, env: { ...process.env, COMPANY_CHECKOUT: checkout }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (b: Buffer) => { out = (out + b.toString()).slice(-4000); };
  p.stdout!.on('data', keep);
  p.stderr!.on('data', keep);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  const fail = (why: string) => rej(new Error(`worktree_setup failed in ${cwd} (${why}): ${out.trim().slice(-600) || 'no output'}`));
  p.on('error', (e) => { clearTimeout(timer); fail(e.message); });
  p.on('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) fail(`timed out after ${Math.round(timeoutMs / 60_000)} min`);
    else if (code === 0) res();
    else fail(code != null ? `exit ${code}` : `signal ${signal}`);
  });
});

/** The start of BaseFetchFailed's message: a node's workspace-cli sends only the message back (RemoteWorkspaces.op). */
export const FETCH_FAILED = 'base fetch failed:';

/** A new worktree's base could not be fetched: the task waits and tries again, it does not start from a stale branch. */
export class BaseFetchFailed extends Error { override name = 'BaseFetchFailed'; }

/**
 * One op at a time in a checkout: a fill starts several tasks on a machine at once, and two `git checkout` (or
 * `git fetch`) in one checkout side by side fail on a lock. A lock dir in .git (`name`), taken over when older than
 * 5 minutes (a crash).
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>, waitMs = 120_000, name = 'company-sync.lock'): Promise<T> {
  const lock = resolve(dir, '.git', name);
  for (const t0 = Date.now(); ;) {
    try { mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 5 * 60_000) rmdirSync(lock); } catch { /* gone meanwhile */ }
      if (Date.now() - t0 > waitMs) throw new Error(`${lock} is held for over ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}

export interface Worktree {
  path: string; branch: string; checkout: string; base: string;
  /** On a node: repos it reads beside the worktree that stayed behind the commit here (nodes.ts RemoteWorkspaces.create). */
  stale?: string[];
}
export interface CloseResult { path: string; preserved: string | null; removed: boolean; branchDeleted: boolean; ignored: string[]; repaired?: boolean; error?: string }

export class Workspaces {
  private git: Git;
  private host: string;
  private setup: Setup;
  constructor(git: Git = runGit, host: string = hostname(), setup: Setup = runSetup) {
    this.git = git;
    this.host = host;
    this.setup = setup;
  }

  /**
   * commands.worktree_setup in a worktree hq just made. When it fails, the half-set-up tree goes (nothing of
   * a worker's is in it yet; with keepBranch, the branch and its commits stay for the next try) and it throws.
   */
  private async runSetup(ch: Charter, c: Checkout, path: string, keepBranch: boolean): Promise<void> {
    if (!ch.commands.worktree_setup) return;
    try {
      await this.setup(path, ch.commands.worktree_setup, c.path);
    } catch (e) {
      const r = await this.close(path, c.defaultBranch, keepBranch);
      throw new Error(`${(e as Error).message}${r.removed ? '' : ` (and the worktree was not removed: ${r.error})`}`);
    }
  }

  /** The checkout a task works in: the named one, else the charter's first. Refuses another machine's checkout. */
  checkout(ch: Charter, name?: string | null): Checkout | null {
    if (ch.checkouts.length === 0) return null;
    const c = name ? ch.checkouts.find((x) => x.name === name) : ch.checkouts[0];
    if (!c) throw new Error(`project ${ch.project} has no checkout "${name}"`);
    if (ch.machine && ch.machine !== this.host) throw new Error(`project ${ch.project} runs on ${ch.machine}, this is ${this.host}`);
    if (!existsSync(join(c.path, '.git'))) throw new Error(`checkout ${c.path} of ${ch.project} is not a git repository`);
    return c;
  }

  /**
   * The base of a new worktree: origin/<default>, just fetched. One fetch at a time in a checkout (a fill starts
   * several tasks there at once, and side by side they fail on the lock of refs/remotes/origin/<default>), tried
   * three times. A fetch that still fails throws BaseFetchFailed: the local default branch can be weeks behind
   * (lumo on ci-host, 10/10 to 01/11: 388 commits), and a task started from it redoes merged work. Only a checkout
   * with no origin at all starts from its local branch.
   */
  async base(c: Checkout, retryMs = 2_000): Promise<string> {
    const hasOrigin = await this.git(c.path, ['remote', 'get-url', 'origin']).then(() => true, () => false);
    if (!hasOrigin) return c.defaultBranch;
    const fetch = () => this.git(c.path, ['fetch', '--quiet', 'origin', c.defaultBranch]);
    const locked = existsSync(join(c.path, '.git', 'HEAD')) ? (fn: () => Promise<string>) => withLock(c.path, fn, 5 * 60_000, 'company-fetch.lock') : (fn: () => Promise<string>) => fn();
    let last: Error | null = null;
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((r) => setTimeout(r, retryMs * i));
      try {
        await locked(fetch);
        return `origin/${c.defaultBranch}`;
      } catch (e) { last = e as Error; }
    }
    throw new BaseFetchFailed(`${FETCH_FAILED} git fetch origin ${c.defaultBranch} in ${c.path} failed 3 times, and the task does not start from the local ${c.defaultBranch}, which may be behind: ${last?.message.slice(0, 300)}`);
  }

  /**
   * New worktree <checkout>/<worktreeDir>/<task> on a new branch named <task> (e.g. company-t12), from origin/<default>
   * after a fetch (base(): throws when the fetch fails). A taken name gets a suffix, never reused.
   * Then commands.worktree_setup runs in it; if that fails, the worktree is closed and create throws.
   */
  async create(ch: Charter, c: Checkout, task: string): Promise<Worktree> {
    if (!SLUG.test(task)) throw new Error(`invalid task slug ${task}`);
    const base = await this.base(c);
    let slug = task;
    for (let i = 0; ; i++) {
      const path = join(c.path, ch.worktreeDir, slug);
      const branch = slug;
      const taken = existsSync(path) || await this.git(c.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
      if (!taken) {
        await this.git(c.path, ['worktree', 'add', '--quiet', '-b', branch, path, base]);
        await this.runSetup(ch, c, path, false);
        return { path, branch, checkout: c.path, base };
      }
      if (i >= 5) throw new Error(`no free worktree name for ${task} in ${c.path}`);
      slug = `${task}-${Date.now().toString(36)}${i}`;
    }
  }

  /** What git sees inside a worktree: its top level and branch (the dry run's proof). */
  async inspect(path: string): Promise<{ toplevel: string; branch: string; clean: boolean }> {
    const toplevel = (await this.git(path, ['rev-parse', '--show-toplevel'])).trim();
    const branch = (await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const clean = (await this.git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() === '';
    return { toplevel, branch, clean };
  }

  /**
   * A linked worktree whose top level is exactly `path` — never a main checkout. Everything that resets,
   * cleans or removes goes through this first.
   */
  async isLinkedWorktree(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    try {
      const [gitDir, common, top] = (await this.git(path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']))
        .trim().split('\n');
      return !!gitDir && !!common && gitDir !== common && realpathSync(top!) === realpathSync(path);
    } catch { return false; }
  }

  /**
   * A worktree whose `.git` file is gone while its directory and git's record of it are still there: a
   * `git worktree remove` cut off midway (hq restarted under it deletes the files in readdir order, `.git`
   * among the first). The `.git` file is written back from the record, so close() preserves what is left
   * and removes it as usual. Nothing happens unless the repository holds a worktree record for exactly
   * this path; true when the file was written.
   */
  async repairGitFile(path: string): Promise<boolean> {
    const dotGit = join(path, '.git');
    if (existsSync(dotGit)) return false;
    try {
      const common = (await this.git(dirname(path), ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
      const records = join(common, 'worktrees');
      const real = realpathSync(path);
      for (const name of readdirSync(records)) {
        const admin = join(records, name);
        const gitdir = (() => { try { return readFileSync(join(admin, 'gitdir'), 'utf8').trim(); } catch { return ''; } })();
        const same = (() => { try { return resolve(admin, gitdir) === resolve(dotGit) || realpathSync(dirname(resolve(admin, gitdir))) === real; } catch { return false; } })();
        if (!gitdir || !same) continue;
        writeFileSync(dotGit, `gitdir: ${admin}\n`);
        return true;
      }
    } catch { /* not inside a repository, or no worktree records */ }
    return false;
  }

  /**
   * A worktree that went missing (removed by hand) comes back on its branch, if the branch is still there.
   * `checkout` is the repository it belongs to (from the charter); without it, <checkout>/<dir>/<task> is assumed.
   * With the charter, a worktree brought back gets its commands.worktree_setup again; if that fails, the
   * tree goes again (the branch stays) and it throws, so a later try runs the setup again.
   */
  async ensure(path: string, checkout?: string, ch?: Charter): Promise<boolean> {
    if (existsSync(path)) {
      if (!(await this.isLinkedWorktree(path))) throw new Error(`${path} is not a linked worktree (a main checkout?)`);
      return true;
    }
    const repo = checkout ?? dirname(dirname(path));
    if (!existsSync(join(repo, '.git'))) return false;
    const branch = path.split('/').pop()!;
    const has = await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (!has) return false;
    await this.git(repo, ['worktree', 'prune']);
    await this.git(repo, ['worktree', 'add', '--quiet', path, branch]);
    const c = ch?.checkouts.find((x) => x.path === repo);
    if (ch && c) await this.runSetup(ch, c, path, true);
    return true;
  }

  /**
   * Close a task's worktree (B.5): uncommitted and untracked (not ignored) files → a commit on
   * refs/company/preserved/<task>, then the tree is cleaned and `git worktree remove` runs without
   * --force. Commits on a detached HEAD that no branch holds go to the same ref. Ignored files
   * (node_modules, *.db, .env…) are not preserved: they are listed in the result.
   * The branch is deleted only when it holds no commit beyond the default branch.
   * A preserved ref already there (an earlier close that was cut off) is never overwritten: the new
   * commit gets it as a second parent. After repairGitFile, files missing from the tree are what the
   * cut-off remove deleted, not work: only added and changed files are preserved. `repaired`: the
   * caller ran repairGitFile itself (workspace-cli, to read the branch first).
   */
  async close(path: string, defaultBranch = 'main', keepBranch = false, repaired = false): Promise<CloseResult> {
    const out: CloseResult = { path, preserved: null, removed: false, branchDeleted: false, ignored: [] };
    if (!existsSync(path)) return { ...out, error: 'missing' };
    if (repaired || await this.repairGitFile(path)) out.repaired = true;
    if (!(await this.isLinkedWorktree(path))) return { ...out, error: 'not a linked worktree: refusing to reset, clean or remove it' };
    const task = path.split('/').pop()!;
    const ref = `refs/company/preserved/${task}`;
    try {
      const repo = dirname(resolve(path, (await this.git(path, ['rev-parse', '--git-common-dir'])).trim()));
      const branch = (await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      out.ignored = (await this.git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])).split('\n').filter(Boolean);
      const dirty = (await this.git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '';
      const head = (await this.git(path, ['rev-parse', 'HEAD'])).trim();
      const old = await this.git(path, ['rev-parse', '--verify', '--quiet', ref]).then((o) => o.trim(), () => '');
      // Writes `tree` on HEAD to the ref, keeping a different commit already there as a second parent.
      const keep = async (tree: string, message: string) => {
        const parents = old && old !== head ? ['-p', 'HEAD', '-p', old] : ['-p', 'HEAD'];
        const commit = (await this.git(path, ['commit-tree', tree, ...parents, '-m', message], HQ_AUTHOR)).trim();
        await this.git(path, ['update-ref', ref, commit]);
        if ((await this.git(path, ['rev-parse', ref])).trim() !== commit) throw new Error(`${ref} was not written`);
        out.preserved = ref;
      };
      // Commits on a detached HEAD that no branch holds: HEAD itself goes to the ref.
      const keepDetached = async () => {
        if (branch !== 'HEAD') return;
        const held = (await this.git(path, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).trim();
        if (held) return;
        if (old && old !== head) return keep(`${head}^{tree}`, `preserved: detached HEAD of ${task}`);
        await this.git(path, ['update-ref', ref, 'HEAD']);
        out.preserved = ref;
      };
      if (!dirty) await keepDetached();
      if (dirty) {
        const tmp = mkdtempSync(join(tmpdir(), 'company-preserve-'));
        try {
          const env = { GIT_INDEX_FILE: join(tmp, 'index') };
          await this.git(path, ['read-tree', 'HEAD'], env);
          await this.git(path, out.repaired ? ['add', '--ignore-removal', '.'] : ['add', '-A'], env);
          const tree = (await this.git(path, ['write-tree'], env)).trim();
          const same = tree === (await this.git(path, ['rev-parse', 'HEAD^{tree}'])).trim();
          if (!same) await keep(tree, `preserved: uncommitted work of ${task} (${branch})`);
          else await keepDetached();
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
        // Everything is in the ref now: clean the tree so the remove below needs no --force.
        await this.git(path, ['reset', '--hard', '--quiet']);
        await this.git(path, ['clean', '-fd', '--quiet']);
      }
      // A ref left by an earlier close that was cut off holds work too: callers (a node's close) fetch it.
      if (old) out.preserved = ref;
      await this.git(repo, ['worktree', 'remove', path]);
      out.removed = true;
      // The worktree dir itself (e.g. .worktrees/) goes too when this was its last worktree.
      try { rmdirSync(dirname(path)); } catch { /* not empty, or not ours to remove */ }
      if (!keepBranch && (branch === task || branch.startsWith('company-'))) {
        const base = await this.git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`]).then(() => `origin/${defaultBranch}`, () => defaultBranch);
        const ahead = (await this.git(repo, ['rev-list', '--count', `${base}..${branch}`])).trim();
        if (ahead === '0') {
          await this.git(repo, ['branch', '--quiet', '-D', branch]);
          out.branchDeleted = true;
        }
      }
    } catch (e) {
      out.error = (e as Error).message;
    }
    return out;
  }
}
