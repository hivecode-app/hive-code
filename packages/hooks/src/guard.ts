// PreToolUse guard (#115): no shift writes into the main agent-company checkout, the one hq runs and
// deploys from. Work happens in a worktree under <checkout>/.worktrees/, memory files change through
// `remember` with `file` (hq folds them into a PR). Pure and synchronous: it runs before every tool call.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const GUARDED_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash'] as const;
/** PreToolUse matcher for the generated settings (adapter buildSettings). */
export const GUARD_MATCHER = GUARDED_TOOLS.join('|');

export interface GuardInput {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

export interface GuardEnv {
  /** The main checkout (COMPANY_REPO); default ~/projects/agent-company. */
  repo?: string;
  identity?: string;
  home?: string;
}

/** Who may run scripts/deploy.sh from the main checkout: the project's CEO. hq itself is no Claude session. */
const DEPLOYER = 'adi';

export const GUARD_REASON = (what: string, root: string): string =>
  `${what} נחסם: זה ה-checkout הראשי של agent-company (\`${root}\`), ש-hq רץ ממנו ושממנו פורסים. `
  + 'עדכון לקובץ זיכרון (מה פתוח, לקחים, יומן): `remember` עם `file` (נתיב תחת `memory/`) ו-`mode` (`append` או `replace`), '
  + 'ו-hq מכניס אותו ב-PR מאוחד. שינוי אחר: PR מ-worktree משלך (`git worktree add -b <ענף> .worktrees/<שם>` מתוך ה-repo), '
  + 'ועורכים רק בתוך `.worktrees/<שם>`.';

/** The protected root, or null when there is none (a dev worktree set as COMPANY_REPO protects nothing). */
export function protectedRoot(env: GuardEnv): string | null {
  const home = env.home ?? homedir();
  const root = resolve(expandHome(env.repo || join(home, 'projects', 'agent-company'), home));
  return root.split(sep).includes('.worktrees') ? null : root;
}

function expandHome(p: string, home: string): string {
  if (p === '~' || p === '$HOME' || p === '${HOME}') return home;
  for (const pre of ['~/', '$HOME/', '${HOME}/']) if (p.startsWith(pre)) return join(home, p.slice(pre.length));
  return p;
}

/** Under root and not under root/.worktrees/. */
export function inMainCheckout(path: string, root: string): boolean {
  if (path !== root && !path.startsWith(root + sep)) return false;
  const rest = path.slice(root.length + 1).split(sep);
  return rest[0] !== '.worktrees';
}

/** Returns the Hebrew reason when the call writes into the main checkout, otherwise null. */
export function checkToolUse(input: GuardInput, env: GuardEnv): string | null {
  const root = protectedRoot(env);
  if (!root) return null;
  const home = env.home ?? homedir();
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const abs = (p: string): string => { const e = expandHome(p, home); return isAbsolute(e) ? resolve(e) : resolve(cwd, e); };

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const p = ti.file_path ?? ti.notebook_path;
    if (typeof p !== 'string' || !p) return null;
    const target = abs(p);
    return inMainCheckout(target, root) ? GUARD_REASON(`\`${tool}\` ל-\`${target}\``, root) : null;
  }
  if (tool === 'Bash' && typeof ti.command === 'string') {
    const hit = bashWrite(ti.command, cwd, root, home, env.identity === DEPLOYER);
    return hit ? GUARD_REASON(`\`Bash\` (${hit})`, root) : null;
  }
  return null;
}

/**
 * Simple detection, not a shell: `>`/`>>` redirections, `tee`, `sed -i`, `cp`/`mv`/`install` and `git commit`, with `cd`
 * tracked across `&&`/`;` (and undone when a subshell ends). Quotes, heredoc bodies, `$(…)`, `((…))` and `[[…]]` are not
 * commands, and a target hidden in a variable is not guessed at. `deployer`: the command that runs `scripts/deploy.sh`
 * passes (only that one, not the rest of the line). Returns what wrote into the main checkout, or null.
 */
export function bashWrite(command: string, cwd0: string, root: string, home: string, deployer = false): string | null {
  let cwd = cwd0;
  const stack: string[] = [];
  const abs = (p: string): string => { const e = expandHome(p, home); return isAbsolute(e) ? resolve(e) : resolve(cwd, e); };
  /** A path we can resolve without running the shell: no `$`/backtick left after ~ and $HOME. */
  const hit = (p: string): boolean => { const e = expandHome(p, home); return !/[$`]/.test(e) && inMainCheckout(abs(p), root); };

  let seg: Tok[] = [];
  const check = (): string | null => {
    const words: string[] = [];
    let redirect: string | null = null;
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i]!;
      if (t.w !== undefined) { words.push(t.w); continue; }
      const next = seg[i + 1]?.w;
      if (next === undefined) continue;
      i++; // an operator's operand is never a command word
      if (redirect || !WRITE_REDIRECTS.has(t.op!) || next.startsWith('/dev/') || (t.op === '>&' && /^(\d+|-)$/.test(next))) continue;
      if (hit(next)) redirect = `כתיבה ל-\`${abs(next)}\``;
    }
    // `$(…)` and backticks run too (lex keeps what bash would run: not in single quotes, not escaped, not `$((…))`).
    for (const t of seg) for (const inner of t.subs ?? []) { const r = bashWrite(inner, cwd, root, home); if (r) return r; }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    const [cmd, ...args] = words;
    const deploy = (w: string | undefined) => !!w && /(^|\/)scripts\/deploy\.sh$/.test(w);
    if (deployer && (deploy(cmd) || ((cmd === 'bash' || cmd === 'sh') && deploy(args[0])))) return null;
    if (redirect) return redirect;
    if (!cmd) return null;
    if (cmd === 'cd' || cmd === 'pushd') { cwd = args[0] && args[0] !== '-' ? abs(args[0]) : home; return null; }
    if (cmd === 'tee') {
      for (const a of args) if (!a.startsWith('-') && hit(a)) return `\`tee\` ל-\`${abs(a)}\``;
    }
    if (cmd === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      const scripted = args.some((a) => a === '-e' || a === '-f' || a.startsWith('--expression') || a.startsWith('--file'));
      const files = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^-[a-zA-Z]*[ef]$/.test(args[i - 1]!)));
      for (const f of scripted ? files : files.slice(1)) if (hit(f)) return `\`sed -i\` על \`${abs(f)}\``;
    }
    if (cmd === 'cp' || cmd === 'mv' || cmd === 'install') {
      const t = args.findIndex((a) => /^-[a-zA-Z]*t$/.test(a) || a.startsWith('--target-directory'));
      const dest = t >= 0 ? (args[t]!.includes('=') ? args[t]!.split('=')[1] : args[t + 1]) : args.filter((a) => !a.startsWith('-')).at(-1);
      if (dest && hit(dest)) return `\`${cmd}\` ל-\`${abs(dest)}\``;
    }
    if (cmd === 'git') {
      let dir = cwd; let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) {
        if (args[i] === '-C' && args[i + 1]) { dir = resolve(dir, expandHome(args[i + 1]!, home)); i += 2; }
        else if (args[i] === '-c' && args[i + 1]) i += 2;
        else i += 1;
      }
      if (args[i] === 'commit' && inMainCheckout(dir, root)) return `\`git commit\` ב-\`${dir}\``;
    }
    return null;
  };

  for (const t of [...lex(command), { op: ';' }]) {
    if (t.op && SEPARATORS.has(t.op)) {
      const r = check();
      if (r) return r;
      seg = [];
      if (t.op === '(') stack.push(cwd);
      if (t.op === ')' && stack.length) cwd = stack.pop()!;
    } else seg.push(t);
  }
  return null;
}

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&']);
const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);

interface Tok { w?: string; op?: string; subs?: string[] }

const OPS = /^(&&|\|\||;;|\|&|&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|[;|&<>()])/;

/** End index (exclusive) of a `$(`, `((` or `[[` group starting at i, nesting and quotes respected. */
function groupEnd(s: string, i: number, open: string, close: string): number {
  let depth = 0; let j = i;
  while (j < s.length) {
    if (s[j] === "'") { const k = s.indexOf("'", j + 1); j = k < 0 ? s.length : k + 1; continue; }
    if (s[j] === '\\') { j += 2; continue; }
    if (s.startsWith(open, j)) { depth++; j += open.length; continue; }
    if (s.startsWith(close, j)) { depth--; j += close.length; if (depth === 0) return j; continue; }
    j++;
  }
  return s.length;
}

/**
 * Words (quotes removed) and operators. A digit fd prefix (`2>`) folds into its operator; heredoc bodies are skipped;
 * `$(…)`, backticks, `((…))` and `[[…]]` stay inside one opaque word.
 */
export function lex(s: string): Tok[] {
  const out: Tok[] = [];
  const heredocs: string[] = [];
  let cur = ''; let inWord = false; let wantDelim = false; let i = 0;
  let subs: string[] = [];
  const flush = (): void => {
    if (!inWord) return;
    out.push(subs.length ? { w: cur, subs } : { w: cur });
    if (wantDelim) { heredocs.push(cur); wantDelim = false; }
    cur = ''; inWord = false; subs = [];
  };
  /** `$(…)` at i (s[i] === '$'): its command, unless it is `$((…))`; returns the end. */
  const dollar = (i: number): number => {
    const e = groupEnd(s, i + 1, '(', ')');
    if (s[i + 2] !== '(') subs.push(s.slice(i + 2, e - 1));
    return e;
  };
  const tick = (i: number): number => {
    const j = s.indexOf('`', i + 1); const e = j < 0 ? s.length : j + 1;
    subs.push(s.slice(i + 1, j < 0 ? s.length : j));
    return e;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const j = s.indexOf("'", i + 1); const end = j < 0 ? s.length : j;
      cur += s.slice(i + 1, end); inWord = true; i = end + 1; continue;
    }
    if (c === '$' && s[i + 1] === '(') { const e = dollar(i); cur += s.slice(i, e); inWord = true; i = e; continue; }
    if (c === '`') { const e = tick(i); cur += s.slice(i, e); inWord = true; i = e; continue; }
    if (!inWord && (s.startsWith('((', i) || s.startsWith('[[', i))) {
      const e = groupEnd(s, i, s.slice(i, i + 2), s[i] === '(' ? '))' : ']]'); out.push({ w: s.slice(i, e) }); i = e; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { j = dollar(j); continue; }
        if (s[j] === '`') { j = tick(j); continue; }
        j++;
      }
      cur += s.slice(i + 1, j).replace(/\\(.)/g, '$1'); inWord = true; i = j + 1; continue;
    }
    if (c === '\\') {
      if (s[i + 1] !== '\n') { cur += s[i + 1] ?? ''; inWord = true; }
      i += 2; continue;
    }
    if (c === '\n') {
      flush(); out.push({ op: ';' }); i++;
      while (heredocs.length) {
        const delim = heredocs.shift()!;
        while (i < s.length) {
          const nl = s.indexOf('\n', i); const end = nl < 0 ? s.length : nl;
          const line = s.slice(i, end); i = end + 1;
          if (line.replace(/^\t+/, '') === delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '#' && !inWord) { while (i < s.length && s[i] !== '\n') i++; continue; }
    const m = OPS.exec(s.slice(i, i + 3));
    if (m) {
      if (inWord && /^\d+$/.test(cur) && (c === '>' || c === '<')) { cur = ''; inWord = false; } else flush();
      out.push({ op: m[1]! }); i += m[1]!.length;
      if (m[1] === '<<' || m[1] === '<<-') wantDelim = true;
      continue;
    }
    cur += c; inWord = true; i++;
  }
  flush();
  return out;
}
