// `remember` with `file` (#115): a worker updates a memory file (what's open, a journal, lessons) without touching
// the main checkout hq runs and deploys from. The op is stored at once (recall sees it), and this folds every pending
// file update into one rolling PR on `company/memory-updates`: a fresh branch from origin/main, or more commits on the
// PR that is still open. It flushes when enough updates wait or the oldest has waited long enough, so at least daily.
// The automation is `memory-files` in org.yaml; its owner gets the PR to review and merge.
// Registries (open-*.md, *-actions.md, customers.md; a company team's memory/company/<team>/open-*.md) skip the PR and land on main at once: memory-registry.ts.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import type { Hq } from './hq.ts';
import { MemoryRegistry } from './memory-registry.ts';

export const AUTOMATION = 'memory-files';
export const BRANCH = 'company/memory-updates';
/** Flush when this many updates wait… */
export const FLUSH_COUNT = 5;
/** …or the oldest has waited this long. */
export const FLUSH_AGE_MS = 60 * 60_000;
export const FILE_MODES = ['append', 'replace'] as const;
export type FileMode = (typeof FILE_MODES)[number];

/** `memory/<…>.md`, relative, no `..`: the only files `remember` may write. Returns the normalized path or null. */
export function memoryFilePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = normalize(raw.trim().replace(/^\.\//, ''));
  if (!/^memory\/[A-Za-z0-9._/-]+\.md$/.test(p) || p.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return p;
}

/** One file update applied to the file's current text. */
export function applyUpdate(current: string | null, text: string, mode: FileMode): string {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (mode === 'replace' || current == null || current === '') return body;
  return `${current.endsWith('\n') ? current : `${current}\n`}${body}`;
}

/** Runs a command in a directory and resolves its stdout as is (not trimmed); injected in tests. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<string>;

export const execRun: Run = (cmd, args, cwd) => new Promise((res, rej) => {
  execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) =>
    (err ? rej(new Error(`${cmd} ${args[0]}: ${(stderr || err.message).trim().slice(0, 300)}`)) : res(out)));
});

/** The open rolling PR as hq last saw it. */
const PR_META = 'memory_files.pr';
/** How long `current` waits for its fetch before reading the refs it has (recall's whole budget is 3s). */
export const FETCH_BUDGET_MS = 1500;
/** Consecutive failed flushes before the owner hears about it (a single network blip is not news). */
export const FAIL_NOTIFY_AFTER = 3;

interface PendingRow { id: string; identity: string; args: string; received_at: number }
export interface Pending { id: string; identity: string; file: string; mode: FileMode; text: string; received_at: number }

export class MemoryFiles {
  private hq: Hq;
  run: Run;
  /** The company repository, COMPANY_HOME (company/ and memory/ live in it). */
  repoDir: string;
  /** Registries: straight to main through one queue. */
  readonly registry: MemoryRegistry;
  constructor(hq: Hq, run: Run = execRun, repoDir = hq.cfg.companyHome) {
    this.hq = hq;
    this.run = run;
    this.repoDir = repoDir;
    const self = this;
    this.registry = new MemoryRegistry(hq, {
      get run() { return self.run; }, get repoDir() { return self.repoDir; },
      fetch: () => this.fetch(), owner: () => this.owner(), enabled: () => this.enabled(),
      notifyOwner: (key, body, priority) => this.notifyOwner(key, body, priority),
    });
  }

  private get db() { return this.hq.store.db; }

  /** The identity whose org.yaml automations hold `memory-files`; null = no such automation. */
  owner(): string | null {
    const r = this.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean { const o = this.owner(); return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`); }

  pending(): Pending[] {
    const rows = this.db.prepare(`SELECT o.id, o.identity, o.args, o.received_at FROM ops o
      WHERE o.op = 'remember' AND json_extract(o.args, '$.file') IS NOT NULL
        AND COALESCE(json_extract(o.args, '$.registry'), 0) != 1
        AND NOT EXISTS (SELECT 1 FROM memory_file_ops f WHERE f.op_id = o.id)
      ORDER BY o.received_at, o.rowid`).all() as PendingRow[];
    return rows.flatMap((r) => {
      const a = JSON.parse(r.args) as Record<string, unknown>;
      const file = memoryFilePath(a.file);
      if (!file || typeof a.text !== 'string') return [];
      return [{ id: r.id, identity: r.identity, file, mode: a.mode === 'replace' ? 'replace' : 'append', text: a.text, received_at: r.received_at }];
    });
  }

  /** The timer's check: something waits, and enough of it or for long enough. */
  due(now = this.hq.store.now()): boolean {
    const p = this.pending();
    return p.length >= FLUSH_COUNT || (p.length > 0 && now - p[0]!.received_at >= FLUSH_AGE_MS);
  }

  private failures = 0;

  async sweep(): Promise<void> {
    if (!this.enabled()) return;
    // Registries left waiting (an hq restart, a failed push): the queue goes again. It tells the owner itself.
    await this.registry.kick().catch(() => {});
    // Every round, so a PR merged since the last flush stops being read as open (current) within minutes.
    if (this.hq.store.getMeta(PR_META)) await this.openPr().catch(() => {});
    if (!this.due()) return;
    try {
      await this.flush();
      this.failures = 0;
    } catch (e) {
      // No silent pile-up (A.2(5)): after a few failed rounds the owner hears it once, with the reason.
      if (++this.failures === FAIL_NOTIFY_AFTER) this.notifyOwner(`fail-${this.hq.store.now()}`,
        `${this.pending().length} עדכונים לקבצי זיכרון מחכים, וה-PR המאוחד נכשל ${FAIL_NOTIFY_AFTER} פעמים ברצף: ${(e as Error).message}`, 'now');
      throw e;
    }
  }

  /**
   * The file as it will be once everything waiting lands: origin/main merged with the rolling branch while its PR is
   * open, plus the pending updates. What a worker reads before a `replace`, through `recall` with the path. A fetch and
   * a look at the PR first, bounded so recall stays in its budget (they finish in the background and the next read
   * has them). A merged PR's branch is never read. null = no such file anywhere yet. A registry: origin/main and the
   * registry writes still queued, never the PR.
   */
  async current(file: string): Promise<string | null> {
    const git = (...a: string[]) => this.run('git', a, this.repoDir);
    const fresh = Promise.all([this.fetch(), this.openPr()]).catch(() => {});
    await Promise.race([fresh, new Promise((r) => setTimeout(r, FETCH_BUDGET_MS).unref())]);
    if (this.registry.isRegistry(file)) return this.registry.current(file);
    let ref = 'origin/main';
    const branch = `origin/${BRANCH}`;
    if (this.hq.store.getMeta(PR_META) && await git('rev-parse', '--verify', '--quiet', branch).then(() => true, () => false)) {
      ref = await git('merge-tree', '--write-tree', 'origin/main', branch).then((out) => out.split('\n')[0]!.trim(), async () =>
        // In conflict (the owner hears at the next flush): the branch's copy only for a file the branch changed.
        (await git('diff', '--quiet', `origin/main...${branch}`, '--', file).then(() => false, () => true)) ? branch : 'origin/main');
    }
    let text: string | null = await git('show', `${ref}:${file}`).catch(() => null);
    for (const o of this.pending()) if (o.file === file) text = applyUpdate(text, o.text, o.mode);
    return text;
  }

  /**
   * main and the rolling branch; a branch deleted on merge is pruned here too. One at a time: a read and a flush (or
   * several reads) share the fetch in flight instead of racing on the same refs.
   */
  private fetching: Promise<string> | null = null;
  fetch(): Promise<string> {
    this.fetching ??= this.run('git', ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main',
      `+refs/heads/${BRANCH}*:refs/remotes/origin/${BRANCH}*`], this.repoDir).finally(() => { this.fetching = null; });
    return this.fetching;
  }

  notifyOwner(key: string, body: string, priority: 'now' | 'next' = 'next'): void {
    const owner = this.owner();
    if (owner) this.hq.mailbox.tell({ msg_id: `memory-files-${key}`, from: 'hq', to: owner, kind: 'system', priority, body });
  }

  /** Every pending update into the rolling PR. Returns its URL, or null when nothing waited. */
  async flush(): Promise<string | null> {
    let ops = this.pending();
    if (!ops.length) return null;
    const git = (...a: string[]) => this.run('git', a, this.repoDir);
    await this.fetch();
    let open = await this.openPr();
    const base = open ? `origin/${BRANCH}` : 'origin/main';
    await git('worktree', 'prune');
    const wt = join(mkdtempSync(join(tmpdir(), 'memory-updates-')), 'wt');
    const mark = (list: Pending[], url: string | null) => {
      const now = this.hq.store.now();
      const ins = this.db.prepare('INSERT OR IGNORE INTO memory_file_ops (op_id, pr, flushed_at) VALUES (?, ?, ?)');
      this.db.transaction(() => { for (const o of list) ins.run(o.id, url, now); })();
    };
    try {
      await git('worktree', 'add', '--quiet', '--detach', wt, base);
      const w = (...a: string[]) => this.run('git', a, wt);
      if (open) {
        // Keep the open PR mergeable: main first. A conflict stops here, the updates stay pending, the owner hears.
        try { await w('merge', '--quiet', '--no-edit', 'origin/main'); }
        catch (e) {
          await w('merge', '--abort').catch(() => {});
          this.notifyOwner(`conflict-${ops[0]!.id}`, `ה-PR המאוחד של קבצי הזיכרון (${open}) מתנגש עם main, ו-${ops.length} עדכונים מחכים. `
            + 'צריך לפתור את ההתנגשות בענף או לסגור את ה-PR, ואז hq ממשיך.', 'now');
          throw new Error(`memory-files: ${BRANCH} conflicts with main: ${(e as Error).message}`);
        }
        // A crash between push and marking last time: what is already on the branch is not applied twice.
        const landed = new Set([...(await w('log', '--format=%B', 'origin/main..HEAD')).matchAll(/^- \S+ · \S+ · \S+ · (\S+)$/gm)].map((m) => m[1]!));
        const again = ops.filter((o) => landed.has(o.id));
        if (again.length) { mark(again, open); ops = ops.filter((o) => !landed.has(o.id)); }
        if (!ops.length) return open;
      }
      for (const o of ops) {
        const f = join(wt, o.file);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, applyUpdate(existsSync(f) ? readFileSync(f, 'utf8') : null, o.text, o.mode));
      }
      await w('add', '--', 'memory');
      const changed = (await w('status', '--porcelain', '--', 'memory')).trim() !== '';
      let url = open;
      if (changed) {
        const files = [...new Set(ops.map((o) => o.file))];
        const who = [...new Set(ops.map((o) => this.hq.mailbox.label(o.identity)))];
        const lines = ops.map((o) => `- ${o.file} · ${o.mode} · ${o.identity} · ${o.id}`);
        await w('commit', '--quiet', '-m', `זיכרון: ${ops.length} עדכונים מ-remember (${who.join(', ')})\n\n${lines.join('\n')}`);
        // No open PR: whatever is on the branch is stale (merged or abandoned), so it starts again from main.
        await w('push', '--quiet', ...(open ? [] : ['--force']), 'origin', `HEAD:refs/heads/${BRANCH}`);
        // Merged between the look and the push: the commit sits on a branch with no PR, so it gets a new one.
        if (open && !(await this.openPr())) open = null;
        if (!open) {
          const body = [
            'עדכונים לקבצי זיכרון שנשמרו ב-`remember` עם `file`. hq מצרף כאן כל עדכון שמגיע, עד שה-PR ממוזג.',
            '', ...lines, '', `קבצים: ${files.map((f) => `\`${f}\``).join(', ')}`,
          ].join('\n');
          url = (await this.run('gh', ['pr', 'create', '--base', 'main', '--head', BRANCH, '--title', 'זיכרון: עדכונים מ-remember', '--body', body], wt)).trim();
        }
        if (url) this.hq.store.setMeta(PR_META, url);
      }
      mark(ops, url ?? null);
      this.hq.store.emit('memory_files.flushed', null, { ops: ops.length, changed, pr: url ?? null });
      if (changed && url) {
        this.notifyOwner(ops[0]!.id,
          `${open ? 'נוספו' : 'נפתח PR עם'} ${ops.length} עדכונים לקבצי זיכרון: ${url}. סקירה לפי skills/reviewer, ומיזוג כשה-CI ירוק.`);
      }
      return url;
    } finally {
      await git('worktree', 'remove', '--force', wt).catch(() => {});
      rmSync(dirname(wt), { recursive: true, force: true });
    }
  }

  private async openPr(): Promise<string | null> {
    const out = (await this.run('gh', ['pr', 'list', '--head', BRANCH, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], this.repoDir)).trim();
    // Seen closed or merged: reads fall back to origin/main.
    this.hq.store.setMeta(PR_META, out);
    return out || null;
  }
}
