// Registries: memory files that are a running record (what's open, an actions log, customers) land on main at once,
// without a PR or a review (Ran, 21/10: «להכניס מיד בלי סקירה אבל … שומר שאנחנו עושים את זה בצורה נכונה בלי
// התנגשויות»). Everything else under memory/ still goes through the rolling PR (memory-files.ts).
//
// The guard: one writer (a single queue in hq, one commit at a time, from a temp worktree, never the main checkout);
// every commit starts from a fresh fetch of main, so `append` never conflicts; `replace` carries the `base_sha` the
// worker read through recall and fails if the file moved since, and the worker gets the new text to try again; the
// path must be a registry in the worker's own project (or, for a company team's `open-*.md`, the worker's own memory
// domain); the text is checked for size, markdown that keeps
// check:contract green, and secrets; every write is an event with who, what and the sha.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { Hq } from './hq.ts';
import { applyUpdate, type FileMode, type Run } from './memory-files.ts';

/** The closed list: `memory/projects/<project>/…`. Group 1 is the project. */
export const REGISTRY_PATTERNS: readonly RegExp[] = [
  /^memory\/projects\/([^/]+)\/open-[^/]+\.md$/,
  /^memory\/projects\/([^/]+)\/[^/]+-actions\.md$/,
  /^memory\/projects\/([^/]+)\/customers\.md$/,
];
/**
 * A company team's own list of what's open: `memory/company/<team>/open-*.md` (the design team's open-noa.md and
 * open-tom.md). Group 1 is the memory domain (`company/design`); the writer's `memory_domain` in org.yaml must match.
 */
export const DOMAIN_REGISTRY = /^memory\/(company\/[^/]+)\/open-[^/]+\.md$/;
/** "Anything marked so": a file in a project folder whose first lines carry this comment (added in a reviewed PR). */
export const REGISTRY_MARK = '<!-- company:registry -->';
/** In a commit message: what deploy.sh reads to leave these commits out of what it reports. */
export const TRAILER = 'Company-Memory-Registry';
/** Push attempts per write (each one a fresh fetch and the change applied again on top). */
export const PUSH_ATTEMPTS = 3;
/** Consecutive `replace` conflicts of one worker on one file before the owner of the automation hears about it. */
export const CONFLICTS_TO_OWNER = 3;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;

/** The project a registry path belongs to, or null when the path is not a registry by its name. */
export function registryProject(file: string): string | null {
  for (const p of REGISTRY_PATTERNS) { const m = p.exec(file); if (m) return m[1]!; }
  return null;
}

/** The company memory domain a registry path belongs to (`company/design`), or null. */
export function registryDomain(file: string): string | null {
  return DOMAIN_REGISTRY.exec(file)?.[1] ?? null;
}

/** git's blob id of a text: the `base_sha` recall hands out, and what a `replace` is checked against. */
export function blobSha(text: string | null): string {
  const b = Buffer.from(text ?? '', 'utf8');
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

const SECRETS: readonly [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, 'Bearer token'],
  // A keyword (with any prefix or suffix: DICTATE_TOKEN, secret_key, AWS_SECRET_ACCESS_KEY) then `:` or `=` and a value
  // that looks like one: no path, env var name, placeholder or Hebrew, and both a digit and a letter (not a count).
  [/\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']?(?![<$*{~/.])(?=[A-Za-z0-9_+/=.-]*\d)(?=[0-9_+/=.-]*[A-Za-z])[A-Za-z0-9_+/=.-]{8,}/i, 'password or token'],
  [/סיסמ[הא]\s*[:=]\s*(?![<$*{])(?=\S*\d)\S{4,}/, 'סיסמה'],
];

/** What looks like a secret in a text, or null. A plain check by pattern, not a scanner. */
export function secretIn(text: string): string | null {
  for (const [re, what] of SECRETS) if (re.test(text)) return what;
  return null;
}

/**
 * Why a registry file would not be valid markdown for the contract, or null: control characters, a code fence left
 * open, or a relative link to nothing (check:contract fails on those, and so would the next deploy). `exists` answers
 * for a path relative to the repository root.
 */
export function markdownProblem(file: string, text: string, exists: (rel: string) => boolean): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return 'יש בטקסט תווי בקרה';
  if (((text.match(/^ {0,3}(```|~~~)/gm) ?? []).length) % 2) return 'בלוק קוד (```) נפתח ולא נסגר';
  // Same reading as check:contract's checkLinks: code is not scanned, scheme links and anchors are not files.
  const prose = text.replace(/(```|~~~)[\s\S]*?\1/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of prose.matchAll(/\]\(([^)]+)\)/g)) {
    let target = m[1]!.trim().replace(/\s+"[^"]*"$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    target = target.replace(/^<(.*)>$/, '$1').replace(/#.*$/, '');
    let decoded: string;
    try { decoded = decodeURIComponent(target); } catch { return `הקישור "${m[1]}" לא מקודד נכון`; }
    const rel = posix.normalize(posix.join(posix.dirname(file), decoded));
    if (rel.startsWith('..') || !exists(rel)) return `הקישור "${m[1]}" מצביע על קובץ שלא קיים`;
  }
  return null;
}

interface PendingRow { id: string; identity: string; args: string; received_at: number }
export interface RegistryOp { id: string; identity: string; file: string; mode: FileMode; text: string; base_sha: string | null }
type Outcome = 'committed' | 'unchanged' | 'conflict' | 'invalid';

export class MemoryRegistry {
  private hq: Hq;
  private host: { run: Run; repoDir: string; fetch(): Promise<string>; owner(): string | null; enabled(): boolean;
    notifyOwner(key: string, body: string, priority?: 'now' | 'next'): void };
  constructor(hq: Hq, host: MemoryRegistry['host']) { this.hq = hq; this.host = host; }

  private get db() { return this.hq.store.db; }

  /** A registry by name or by mark (read from the deployed checkout, which is where a reviewed mark arrives). */
  isRegistry(file: string): boolean {
    if (registryProject(file) || registryDomain(file)) return true;
    if (!/^memory\/projects\/[^/]+\/[^/]+\.md$/.test(file)) return false;
    try { return readFileSync(join(this.host.repoDir, file), 'utf8').split('\n', 5).some((l) => l.trim() === REGISTRY_MARK); }
    catch { return false; }
  }

  /**
   * The checks at the door (ingest, synchronous): a registry path in the writer's own project (or own memory domain,
   * for `memory/company/<team>/open-*.md`), a folder that exists with its INDEX.md (or check:contract fails). Size and secrets are checked for every file update (ingest). Returns the reason in Hebrew, or null.
   */
  refuse(identity: string, file: string): string | null {
    const domain = registryDomain(file);
    if (domain) {
      const row = this.db.prepare('SELECT data FROM identities WHERE id = ?').get(identity) as { data: string } | undefined;
      let mine: unknown = null;
      try { mine = (JSON.parse(row?.data ?? '{}') as { memory_domain?: unknown }).memory_domain; } catch { /* no domain */ }
      if (mine !== domain) {
        return `\`${file}\` הוא רישום של התחום \`${domain}\`, ו${typeof mine === 'string' && mine ? `התחום שלך הוא \`${mine}\`` : 'אין לך תחום זיכרון'}. `
          + 'רישום של תחום אחר מעדכנים ב-PR מ-worktree של agent-company, או מבקשים מבעל הקובץ.';
      }
      if (!existsSync(join(this.host.repoDir, 'memory', domain, 'INDEX.md'))) {
        return `אין תיקייה \`memory/${domain}/\` עם \`INDEX.md\`. תיקייה חדשה נפתחת ב-PR.`;
      }
      return null;
    }
    const project = file.split('/')[2]!;
    const mine = (this.db.prepare('SELECT project FROM identities WHERE id = ?').get(identity) as { project: string | null } | undefined)?.project;
    if (mine !== project) {
      return `\`${file}\` הוא רישום של הפרויקט \`${project}\`, ו${mine ? `הפרויקט שלך הוא \`${mine}\`` : 'אין לך פרויקט'}. `
        + 'רישום של פרויקט אחר מעדכנים ב-PR מ-worktree של agent-company, או מבקשים מבעל הקובץ.';
    }
    if (!existsSync(join(this.host.repoDir, 'memory', 'projects', project, 'INDEX.md'))) {
      return `אין תיקייה \`memory/projects/${project}/\` עם \`INDEX.md\`. תיקייה חדשה נפתחת ב-PR.`;
    }
    return null;
  }

  pending(): RegistryOp[] {
    const rows = this.db.prepare(`SELECT o.id, o.identity, o.args, o.received_at FROM ops o
      WHERE o.op = 'remember' AND json_extract(o.args, '$.registry') = 1 AND json_extract(o.args, '$.file') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memory_file_ops f WHERE f.op_id = o.id)
      ORDER BY o.received_at, o.rowid`).all() as PendingRow[];
    return rows.map((r) => {
      const a = JSON.parse(r.args) as Record<string, unknown>;
      return { id: r.id, identity: r.identity, file: String(a.file), mode: a.mode === 'replace' ? 'replace' : 'append', text: String(a.text),
        base_sha: typeof a.base_sha === 'string' && a.base_sha ? a.base_sha.toLowerCase() : null };
    });
  }

  /** The file as it will be once the queue drains: origin/main plus the registry writes still waiting. */
  async current(file: string): Promise<string | null> {
    let text: string | null = await this.host.run('git', ['show', `origin/main:${file}`], this.host.repoDir).catch(() => null);
    // A replace that will conflict changes nothing, as in write(). An append that write() will refuse (size, a broken
    // link) is still counted here: a replace built on it then conflicts, and the worker gets the real text to retry.
    // Rare and safe, so not worth a second copy of the checks.
    for (const o of this.pending()) if (o.file === file && (o.mode === 'append' || (o.base_sha ? blobSha(text).startsWith(o.base_sha) : text == null))) {
      text = applyUpdate(text, o.text, o.mode);
    }
    return text;
  }

  private draining: Promise<void> | null = null;
  private failures = 0;

  /** Starts the queue if it is idle; the promise of the drain in flight. One writer: never two drains at once. */
  kick(): Promise<void> {
    if (!this.host.enabled()) return Promise.resolve();
    // A write that arrived while the drain was cleaning up got this drain's promise: go again rather than leave it
    // for the sweep. The loop only returns with nothing pending, and a failure does not loop (the sweep retries).
    this.draining ??= this.drain().then(() => {
      this.draining = null;
      return this.pending().length ? this.kick() : undefined;
    }, (e: unknown) => { this.draining = null; throw e; });
    return this.draining;
  }

  /** Every waiting write, in the order they came, one commit each. A push that keeps failing stops the round. */
  private async drain(): Promise<void> {
    if (!this.pending().length) return;
    const git = (...a: string[]) => this.host.run('git', a, this.host.repoDir);
    await git('worktree', 'prune').catch(() => {});
    const wt = join(mkdtempSync(join(tmpdir(), 'memory-registry-')), 'wt');
    try {
      await this.host.fetch();
      await git('worktree', 'add', '--quiet', '--detach', wt, 'origin/main');
      // Re-read after each write: what arrived while one was committing goes next, in the same round.
      for (let ops = this.pending(); ops.length; ops = this.pending()) {
        try { await this.write(ops[0]!, wt); }
        catch (e) {
          // No silent pile-up (A.2(5)): the owner hears once per streak, after a write used up its attempts; the sweep tries again.
          if (++this.failures === 1) this.host.notifyOwner(`registry-fail-${ops[0]!.id}`,
            `${ops.length} רישומים בזיכרון מחכים: הכתיבה ל-main נכשלה ${PUSH_ATTEMPTS} פעמים ברצף, וה-sweep ינסה שוב כל 10 דקות. ${(e as Error).message}`, 'now');
          throw e;
        }
        this.failures = 0;
      }
    } finally {
      await git('worktree', 'remove', '--force', wt).catch(() => {});
      rmSync(dirname(wt), { recursive: true, force: true });
    }
  }

  /** One write: fetch, start from main, apply, validate, commit, push; again from a fresh main if the push lost a race. */
  private async write(o: RegistryOp, wt: string): Promise<void> {
    const w = (...a: string[]) => this.host.run('git', a, wt);
    let lastErr: Error | null = null;
    // The ingest checked the path; checked again here, so only what is a registry of the writer's project lands.
    const why = this.isRegistry(o.file) ? this.refuse(o.identity, o.file) : 'זה לא רישום';
    if (why) return this.invalid(o, why);
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      // The first try starts from origin/main as the drain's fetch left it, moved by our own pushes (update-ref below).
      // If anyone else pushed since, the push is not a fast-forward, is refused, and the next try fetches first.
      if (attempt > 1) await this.host.fetch();
      await w('checkout', '--quiet', '--force', '--detach', 'origin/main');
      await w('clean', '-fdq');
      // A crash between push and marking last time: already on main, not written twice.
      const id = o.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const landed = (await w('log', '-n', '200', '--format=%H', '-E', `--grep=^${TRAILER}: ${id}$`, 'origin/main')).trim().split('\n')[0];
      if (landed) return this.done(o, 'committed', landed);
      const path = join(wt, o.file);
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (o.mode === 'replace') {
        const sha = blobSha(before);
        // No base_sha is fine only for a file that does not exist yet; otherwise the worker did not read it first.
        if (o.base_sha ? !sha.startsWith(o.base_sha) || o.base_sha.length < 7 : before != null) return this.conflict(o, before, sha);
      }
      const after = applyUpdate(before, o.text, o.mode);
      const bad = Buffer.byteLength(after) > MAX_FILE_BYTES ? `הקובץ יהיה גדול מ-${MAX_FILE_BYTES / 1024}KB`
        : markdownProblem(o.file, after, (rel) => existsSync(join(wt, rel)));
      if (bad) return this.invalid(o, bad);
      if (after === before) return this.done(o, 'unchanged', null);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, after);
      await w('add', '--', o.file);
      const who = this.hq.mailbox.label(o.identity);
      await w('commit', '--quiet', '--no-verify', '-m',
        `זיכרון: ${o.file} (${who}, ${o.mode})\n\nרישום מ-remember, נכנס מיד בלי PR (memory-registry.ts).\n\n${TRAILER}: ${o.id}`);
      try {
        await w('push', '--quiet', 'origin', 'HEAD:refs/heads/main');
      } catch (e) {
        // Someone else moved main first: fetch, and the same change again on top (append adds at the new end).
        lastErr = e as Error;
        continue;
      }
      // origin/main follows what we pushed, so the next write (and recall) start from it without another fetch.
      const sha = (await w('rev-parse', 'HEAD')).trim();
      await this.host.run('git', ['update-ref', 'refs/remotes/origin/main', sha], this.host.repoDir).catch(() => {});
      return this.done(o, 'committed', sha);
    }
    throw new Error(`memory-registry: ${o.file}: push failed ${PUSH_ATTEMPTS} times: ${lastErr?.message ?? ''}`);
  }

  private done(o: RegistryOp, outcome: Outcome, sha: string | null): void {
    this.db.prepare('INSERT OR IGNORE INTO memory_file_ops (op_id, pr, flushed_at, sha, outcome) VALUES (?, NULL, ?, ?, ?)')
      .run(o.id, this.hq.store.now(), sha, outcome);
    // The journal: who wrote what, and the commit it landed in.
    this.hq.store.emit('memory_files.registry', o.identity, { op: o.id, file: o.file, mode: o.mode, outcome, sha });
  }

  private conflict(o: RegistryOp, text: string | null, sha: string): void {
    this.done(o, 'conflict', null);
    const streak = this.conflictStreak(o.identity, o.file);
    const toOwner = streak >= CONFLICTS_TO_OWNER;
    const owner = this.host.owner();
    const fence = '~~~~~';
    this.hq.mailbox.tell({ msg_id: `${o.id}-conflict`, from: 'hq', to: o.identity, kind: 'system', priority: 'now', ref: o.id,
      body: [`ה-\`replace\` שלך ל-\`${o.file}\` לא נכנס: ${o.base_sha ? `הקובץ השתנה מאז שקראת אותו (\`base_sha\` ${o.base_sha.slice(0, 12)})` : 'לא צירפת `base_sha`'}.`,
        toOwner ? `זה הניסיון ה-${streak} ברצף, ולכן זה עבר ל-${owner ? this.hq.mailbox.label(owner) : "הבעלים של הזיכרון"}. לא לנסות שוב.`
          : `זה התוכן הנוכחי. כתוב את הגרסה החדשה על בסיסו, ושלח שוב \`remember\` עם \`base_sha: "${sha}"\`.`,
        '', fence, text ?? '(הקובץ עוד לא קיים)', fence].join('\n') });
    if (toOwner) this.host.notifyOwner(`registry-conflict-${o.id}`,
      `${this.hq.mailbox.label(o.identity)} (\`${o.identity}\`) ניסה ${streak} פעמים ברצף להחליף את \`${o.file}\`, ובכל פעם הקובץ השתנה בינתיים. `
        + 'הטקסט האחרון שלו שמור ב-op `' + o.id + '`. צריך להחליט מה נכנס.', 'now');
  }

  private invalid(o: RegistryOp, why: string): void {
    this.done(o, 'invalid', null);
    this.hq.mailbox.tell({ msg_id: `${o.id}-invalid`, from: 'hq', to: o.identity, kind: 'system', priority: 'now', ref: o.id,
      body: `העדכון ל-\`${o.file}\` לא נכנס: ${why}. לתקן ולשלוח שוב.` });
  }

  /** The conflicts in a row, newest first, of one worker on one file (the one just marked included). */
  private conflictStreak(identity: string, file: string): number {
    const rows = this.db.prepare(`SELECT f.outcome FROM memory_file_ops f JOIN ops o ON o.id = f.op_id
      WHERE o.identity = ? AND json_extract(o.args, '$.file') = ? AND json_extract(o.args, '$.registry') = 1
      ORDER BY f.flushed_at DESC, f.rowid DESC LIMIT ?`).all(identity, file, CONFLICTS_TO_OWNER + 1) as { outcome: string }[];
    let n = 0;
    for (const r of rows) { if (r.outcome !== 'conflict') break; n++; }
    return n;
  }
}
