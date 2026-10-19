// Where a project's workers run (B.5). The charter (company/projects/<p>.md) names the checkout(s) on
// a machine; hq creates one worktree per task there (`git worktree add -b`), runs the shift in it, and
// on close preserves anything uncommitted under refs/company/preserved/<task> before removing the
// worktree without --force.
import { execFile } from 'node:child_process';
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

export interface Charter {
  project: string;
  status: string;         // active | dormant | …
  machine: string | null;
  checkouts: Checkout[];
  worktreeDir: string;    // relative to the checkout: <checkout>/<worktreeDir>/<task>
  commands: Record<string, string>;
  ciCheck: string | null;
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
    return { project, status: 'invalid', machine: null, checkouts: [], worktreeDir: '.worktrees', commands: {}, ciCheck: null, error: (e as Error).message };
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
  };
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

export interface Worktree { path: string; branch: string; checkout: string; base: string }
export interface CloseResult { path: string; preserved: string | null; removed: boolean; branchDeleted: boolean; ignored: string[]; error?: string }

export class Workspaces {
  private git: Git;
  private host: string;
  constructor(git: Git = runGit, host: string = hostname()) {
    this.git = git;
    this.host = host;
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
   */
  async ensure(path: string, checkout?: string): Promise<boolean> {
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
    return true;
  }

  /**
   * Close a task's worktree (B.5): uncommitted and untracked (not ignored) files → a commit on
   * refs/company/preserved/<task>, then the tree is cleaned and `git worktree remove` runs without
   * --force. Commits on a detached HEAD that no branch holds go to the same ref. Ignored files
   * (node_modules, *.db, .env…) are not preserved: they are listed in the result.
   * The branch is deleted only when it holds no commit beyond the default branch.
   */
  async close(path: string, defaultBranch = 'main'): Promise<CloseResult> {
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
      if (branch === task || branch.startsWith('company-')) {
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
