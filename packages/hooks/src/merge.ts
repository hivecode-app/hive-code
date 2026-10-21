// PreToolUse merge gate (dir-0011): a PR merges only when a review comment on its LAST commit says approve.
// `detectMerges` is pure and synchronous (every Bash call pays for it); only a command that merges pays for `gh`.
import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { lex, type Tok } from './guard.ts';

export interface MergeTarget {
  /** owner/name, or undefined: gh decides from the cwd. */
  repo?: string;
  /** PR number, URL or branch as written; undefined: the current branch's PR. */
  ref?: string;
  /** Where the command runs (after `cd`). */
  cwd: string;
  /** GH_REPO from the command's own env prefix: the check must run with it too. */
  env?: string;
  /** A merge we cannot tie to a PR (GraphQL mutation): blocked. */
  unverifiable?: boolean;
}

export type GhRun = (args: string[], cwd: string, env?: Record<string, string>) => Promise<string>;

const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'timeout', 'nohup', 'time', 'nice', 'stdbuf', 'xargs', 'eval', '!', '{',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'for']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const SEP = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);
const PR_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const API_MERGE = /^\/?repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge\/?(\?.*)?$/;

/** Every PR merge the command performs: `gh pr merge` (any flags), and `gh api …/pulls/<n>/merge`. */
export function detectMerges(command: string, cwd0: string): MergeTarget[] {
  const out: MergeTarget[] = [];
  const scan = (cmd: string, startCwd: string): void => {
    let cwd = startCwd;
    const stack: string[] = [];
    let seg: Tok[] = [];
    const flush = (): void => {
      const words = seg.map((t) => t.w ?? '');
      for (const t of seg) for (const sub of t.subs ?? []) scan(sub, cwd);
      seg = [];
      let i = 0; let envRepo: string | undefined;
      for (;;) {
        const w = words[i] ?? '';
        const asg = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
        if (asg) { if (asg[1] === 'GH_REPO') envRepo = asg[2]; i++; continue; }
        if (WRAPPERS.has(w)) { i++; while (words[i] && (words[i]!.startsWith('-') || /^\d+[smhd]?$/.test(words[i]!))) i++; continue; }
        break;
      }
      // `bash -c "…"`, `eval "…"` (a wrapper, so the string is the command word), `xargs -I{} sh -c '…'`
      if (/\s/.test(words[i] ?? '')) { scan(words[i]!, cwd); return; }
      if (SHELLS.has((words[i] ?? '').replace(/^.*\//, ''))) { for (const w of words.slice(i + 1)) if (/\s/.test(w)) scan(w, cwd); return; }
      if (words[i] === 'cd' && words[i + 1]) {
        const d = words[i + 1]!;
        cwd = isAbsolute(d) ? resolve(d) : resolve(cwd, d);
        return;
      }
      if (!/(^|\/)gh$/.test(words[i] ?? '') && !/^\$\{?\w+\}?$/.test(words[i] ?? '')) return;
      const rest = words.slice(i + 1);
      if (rest[0] === 'pr' && rest[1] === 'merge') {
        let repo: string | undefined; let ref: string | undefined;
        const args = rest.slice(2);
        for (let k = 0; k < args.length; k++) {
          const a = args[k]!;
          if (a === '-R' || a === '--repo') { repo = args[++k]; continue; }
          if (a.startsWith('--repo=')) { repo = a.slice(7); continue; }
          if (a.startsWith('-R') && a.length > 2) { repo = a.slice(2); continue; }
          if (a === '-b' || a === '--body' || a === '-F' || a === '--body-file' || a === '-t' || a === '--subject'
            || a === '--match-head-commit' || a === '-A' || a === '--author-email') { k++; continue; }
          if (a.startsWith('-')) continue;
          ref ??= a;
        }
        const u = ref ? PR_URL.exec(ref) : null;
        if (u) { repo ??= u[1]; ref = u[2]; }
        out.push({ repo: repo ?? envRepo, ref, cwd, env: envRepo });
      } else if (rest[0] === 'api') {
        for (const a of rest.slice(1)) {
          const m = API_MERGE.exec(a);
          if (m) out.push({ repo: /[{:]/.test(m[1]!) ? envRepo : m[1], ref: m[2], cwd, env: envRepo });
          if (/mergePullRequest|enablePullRequestAutoMerge/.test(a)) out.push({ ref: undefined, cwd, unverifiable: true });
        }
      }
    };
    for (const t of [...lex(cmd), { op: ';' }]) {
      if (t.op && SEP.has(t.op)) {
        flush();
        if (t.op === '(') stack.push(cwd);
        if (t.op === ')' && stack.length) cwd = stack.pop()!;
      } else seg.push(t);
    }
  };
  scan(command, cwd0);
  return out;
}

interface Dated { body?: string; createdAt?: string; submittedAt?: string }
interface PrView { headRefOid?: string; comments?: Dated[]; reviews?: Dated[] }

const MARKER = /(?<![\w-])reviewed:[ \t]*([0-9a-f]{7,40})\b|ship-step-4:[ \t]*reviewed[ \t]+([0-9a-f]{7,40})\b/gi;
// A whole line only: a `changes` comment that quotes the string inside a sentence must not pass.
const DECISION = /^\*\*החלטה: (approve|changes)\*\*[ \t]*$/im;

/** The verdict of the latest comment/review that names `oid`: 'approve', 'changes', or null when none does. */
export function verdictFor(view: PrView): 'approve' | 'changes' | null {
  const oid = (view.headRefOid ?? '').toLowerCase();
  if (!oid) return null;
  const items = [...(view.comments ?? []), ...(view.reviews ?? [])]
    .map((x, n) => ({ body: x.body ?? '', t: x.createdAt ?? x.submittedAt ?? '', n }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.n - b.n));
  let verdict: 'approve' | 'changes' | null = null;
  for (const it of items) {
    for (const m of it.body.matchAll(MARKER)) {
      const sha = (m[1] ?? m[2] ?? '').toLowerCase();
      if (!oid.startsWith(sha)) continue;
      if (m[2]) { verdict = 'approve'; continue; } // the lumo mark: written only once the findings are closed
      const d = DECISION.exec(it.body.replace(/\r/g, '').slice(m.index! + m[0].length));
      verdict = d && d[1]!.toLowerCase() === 'approve' ? 'approve' : 'changes';
    }
  }
  return verdict;
}

const HOW = 'פותחים סוקר בלתי תלוי לפי `skills/reviewer` (סוכן משנה בלי כלי עריכה); הוא כותב הערה על ה-PR עם השורה '
  + '`reviewed: <headRefOid>` ואחריה `**החלטה: approve**`. אחרי push חדש הסקירה צריכה לרוץ מחדש על ה-commit החדש.';

export const defaultGh: GhRun = (args, cwd, env) => new Promise((res, rej) => {
  execFile('gh', args, { cwd, env: { ...process.env, ...env }, timeout: 6000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? rej(err) : res(stdout)));
});

/** Hebrew deny reason when the command merges a PR without an approve on its head commit; null otherwise.
 *  A failed check blocks too (no fail-open). */
export async function checkMerge(command: string, cwd: string, run: GhRun = defaultGh): Promise<string | null> {
  const targets = detectMerges(command, cwd);
  for (const t of targets) {
    if (t.unverifiable) return 'מיזוג דרך `gh api graphql` נחסם: אי אפשר לקשור אותו ל-PR ולבדוק עליו סקירה. ממזגים עם `gh pr merge <n>`.';
    const what = `${t.repo ?? 'ה-repo הנוכחי'}${t.ref ? `#${t.ref}` : ' (ה-PR של הענף הנוכחי)'}`;
    let view: PrView;
    try {
      const args = ['pr', 'view', ...(t.ref ? [t.ref] : []), ...(t.repo ? ['--repo', t.repo] : []), '--json', 'headRefOid,comments,reviews'];
      view = JSON.parse(await run(args, t.cwd, t.env ? { GH_REPO: t.env } : undefined)) as PrView;
    } catch (e) {
      return `מיזוג של ${what} נחסם: בדיקת הסקירה לא רצה (${e instanceof Error ? e.message.split('\n')[0] : String(e)}), ואין מיזוג בלי שהיא עברה. `
        + 'בודקים ש-`gh` מחובר ושיש רשת, ומנסים שוב.';
    }
    const v = verdictFor(view);
    if (v === 'approve') continue;
    const sha = (view.headRefOid ?? '?').slice(0, 7);
    return `מיזוג של ${what} נחסם: אין approve רשום על ה-commit האחרון (\`${sha}\`). `
      + (v === 'changes' ? 'הסקירה האחרונה על ה-commit הזה היא `changes`. מתקנים, דוחפים, וסוקר חוזר. ' : 'לא נמצאה הערה או review עם `reviewed: <sha>` שמתאים ל-commit הזה. ')
      + HOW;
  }
  return null;
}
