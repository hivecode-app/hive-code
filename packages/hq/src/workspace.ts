// Where a project's workers run (B.5). The charter (company/projects/<p>.md) names the checkout(s) on
// a machine; hq creates one worktree per task there (`git worktree add -b`), runs the shift in it, and
// on close preserves anything uncommitted under refs/company/preserved/<task> before removing the
// worktree without --force.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

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
  error?: string;         // status "invalid": why the charter could not be read
}

/** No workers for this charter: dormant (not moved to the company yet) or unreadable. */
export const noWorkers = (ch: Charter | null) => ch?.status === 'dormant' || ch?.status === 'invalid';

const expand = (p: string) => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
    return { project, status: 'invalid', machine: null, checkouts: [], worktreeDir: '.worktrees', commands: {}, ciCheck: null, mergeInstructions: null, designReview: null, error: (e as Error).message };
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
    mergeInstructions: steps(fm.merge_instructions), designReview: designReview(fm.design_review),
  };
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

export interface Worktree { path: string; branch: string; checkout: string; base: string }
export interface CloseResult { path: string; preserved: string | null; removed: boolean; branchDeleted: boolean; ignored: string[]; error?: string }

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
   * New worktree <checkout>/<worktreeDir>/<task> on a new branch named <task> (e.g. company-t12), from origin/<default>
   * (fetched first; the local default branch if the fetch fails). A taken name gets a suffix, never reused.
   * Then commands.worktree_setup runs in it; if that fails, the worktree is closed and create throws.
   */
  async create(ch: Charter, c: Checkout, task: string): Promise<Worktree> {
    if (!SLUG.test(task)) throw new Error(`invalid task slug ${task}`);
    let base = c.defaultBranch;
    try {
      await this.git(c.path, ['fetch', '--quiet', 'origin', c.defaultBranch]);
      base = `origin/${c.defaultBranch}`;
    } catch { /* offline or no origin: the local branch */ }
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
   */
  async close(path: string, defaultBranch = 'main', keepBranch = false): Promise<CloseResult> {
    const out: CloseResult = { path, preserved: null, removed: false, branchDeleted: false, ignored: [] };
    if (!existsSync(path)) return { ...out, error: 'missing' };
    if (!(await this.isLinkedWorktree(path))) return { ...out, error: 'not a linked worktree: refusing to reset, clean or remove it' };
    const task = path.split('/').pop()!;
    const ref = `refs/company/preserved/${task}`;
    try {
      const repo = dirname(resolve(path, (await this.git(path, ['rev-parse', '--git-common-dir'])).trim()));
      const branch = (await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      out.ignored = (await this.git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])).split('\n').filter(Boolean);
      const dirty = (await this.git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '';
      if (!dirty && branch === 'HEAD') {
        const held = (await this.git(path, ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).trim();
        if (!held) {
          await this.git(path, ['update-ref', ref, 'HEAD']);
          out.preserved = ref;
        }
      }
      if (dirty) {
        const tmp = mkdtempSync(join(tmpdir(), 'company-preserve-'));
        try {
          const env = { GIT_INDEX_FILE: join(tmp, 'index') };
          await this.git(path, ['read-tree', 'HEAD'], env);
          await this.git(path, ['add', '-A'], env);
          const tree = (await this.git(path, ['write-tree'], env)).trim();
          const commit = (await this.git(path, ['commit-tree', tree, '-p', 'HEAD', '-m', `preserved: uncommitted work of ${task} (${branch})`], HQ_AUTHOR)).trim();
          await this.git(path, ['update-ref', ref, commit]);
          if ((await this.git(path, ['rev-parse', ref])).trim() !== commit) throw new Error(`${ref} was not written`);
          out.preserved = ref;
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
        // Everything is in the ref now: clean the tree so the remove below needs no --force.
        await this.git(path, ['reset', '--hard', '--quiet']);
        await this.git(path, ['clean', '-fd', '--quiet']);
      }
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
