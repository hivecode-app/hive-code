// The node half of RemoteWorkspaces (nodes.ts): hq sends one op as JSON on stdin, this runs it with the same
// Workspaces code on this machine's checkouts, and prints {ok, result | error} as the last line.
//   {op: 'create', project, checkout, task} · {op: 'ensure', path, checkout, project} · {op: 'close', path, defaultBranch, keepBranch}
// Every op first moves this machine's copy of the company (companyHome) to hq's commit, so it reads the same charter.
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readCharter, runGit, withLock, Workspaces, type Git } from './workspace.ts';

export interface WorkspaceOp {
  op: 'create' | 'ensure' | 'close';
  companyHome: string; companySha?: string | null;
  project?: string | null; checkout?: string | null; task?: string; path?: string; defaultBranch?: string; keepBranch?: boolean;
}

/** The company checkout here at hq's commit (fetched when missing; origin's main when hq's is not on origin). */
export async function syncCompany(home: string, sha: string | null | undefined, git: Git = runGit): Promise<void> {
  if (!existsSync(resolve(home, '.git'))) throw new Error(`no company checkout at ${home}`);
  return withLock(home, () => sync(home, sha, git));
}

async function sync(home: string, sha: string | null | undefined, git: Git): Promise<void> {
  const has = (r: string) => git(home, ['cat-file', '-e', `${r}^{commit}`]).then(() => true, () => false);
  if (!sha || !(await has(sha))) await git(home, ['fetch', '--quiet', 'origin']).catch(() => {});
  const target = sha && (await has(sha)) ? sha : 'origin/main';
  await git(home, ['checkout', '--quiet', '--detach', target]);
}

export async function runOp(o: WorkspaceOp, git: Git = runGit, ws?: Workspaces): Promise<unknown> {
  await syncCompany(o.companyHome, o.companySha, git);
  const companyDir = resolve(o.companyHome, 'company');
  const charter = (p: string | null | undefined) => {
    const ch = p ? readCharter(companyDir, p) : null;
    if (p && !ch) throw new Error(`no charter for ${p}`);
    return ch;
  };
  switch (o.op) {
    case 'create': {
      const ch = charter(o.project)!;
      // The charter's `machine` is where the project's standing workers run; a node takes its tasks too.
      const w = ws ?? new Workspaces(git, ch.machine ?? undefined);
      const c = w.checkout(ch, o.checkout);
      if (!c) throw new Error(`charter of ${o.project} names no checkout`);
      return w.create(ch, c, o.task!);
    }
    case 'ensure':
      return (ws ?? new Workspaces(git)).ensure(o.path!, o.checkout ?? undefined, charter(o.project) ?? undefined);
    case 'close': {
      // The repository, read before the worktree goes: hq fetches the preserved ref from it. A worktree whose
      // .git a cut-off remove took gets it back first, or git would answer for the main checkout around it.
      const w = ws ?? new Workspaces(git);
      const repaired = await w.repairGitFile(o.path!);
      const common = await git(o.path!, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((s) => s.trim(), () => null);
      const branch = await git(o.path!, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim(), () => null);
      const r = await w.close(o.path!, o.defaultBranch, o.keepBranch, repaired);
      return { ...r, ...(common ? { repo: dirname(common) } : {}), ...(branch ? { branch } : {}) };
    }
    default: throw new Error(`unknown op ${String((o as { op?: unknown }).op)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let s = '';
  process.stdin.on('data', (d) => { s += String(d); });
  process.stdin.on('end', async () => {
    try { process.stdout.write(`\n${JSON.stringify({ ok: true, result: await runOp(JSON.parse(s) as WorkspaceOp) })}\n`); }
    catch (e) { process.stdout.write(`\n${JSON.stringify({ ok: false, error: (e as Error).message })}\n`); }
  });
}
