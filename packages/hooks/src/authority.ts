// The five classes no worker may run (company/directives.md, "Authority"), refused in PreToolUse (#480).
// Workers run with bypassPermissions, so a PermissionRequest hook (the owner's ~/.claude/hooks/permission-authority.mjs)
// fires only on the rare call that would still prompt: this check runs before every Bash call instead, from the engine,
// so every installation has it. Deliberately tiny, as the owner's list is: pure destruction or an outage.
// The command is read with the checkout guard's lexer, so only what bash would run counts: text in quotes, a heredoc
// body or a grep pattern (`grep -E "(reboot|shutdown)"`, `git commit -m "fix reboot"`) passes, and so does
// `rm -rf ~/projects/x`. `$(…)`, backticks and `bash -c '…'` are read as commands too.
import { homedir } from 'node:os';
import { lex, type Tok } from './guard.ts';

const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&']);
/** A disk, not a file: what a raw write may never target. */
const BLOCK_DEVICE = /^\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk|dm-|mapper\/|disk\/)/;
const SYSTEM_DIRS = new Set(['/home', '/etc', '/usr', '/var', '/boot', '/root', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/srv']);
/** Words that start a compound command or a pipeline, not the command itself. */
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
/** Commands that run the rest of the line as a command, and their options that take a value. */
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  exec: new Set(['-a']), command: new Set(), builtin: new Set(), nohup: new Set(), time: new Set(),
  nice: new Set(['-n']), ionice: new Set(['-c', '-n', '-t']), stdbuf: new Set(['-i', '-o', '-e']),
  env: new Set(['-u', '-C', '-S']),
  xargs: new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-a']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
};

export const REFUSE = {
  rm: 'recursive delete of a system or home root',
  mkfs: 'filesystem format',
  dd: 'raw write to a block device',
  fork: 'fork bomb',
  power: 'host power state change: it would kill hq and every running shift',
} as const;

const FORK_BOMB = /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/;

/** `/`, home, `/home/<user>` or a system directory, after ~ and $HOME, with any trailing `/` or `/*`. */
function isRoot(p: string, home: string): boolean {
  let e = p;
  for (const pre of ['~', '$HOME', '${HOME}']) if (e === pre || e.startsWith(`${pre}/`)) { e = home + e.slice(pre.length); break; }
  while (e !== '/' && /\/\*?$/.test(e)) e = e.replace(/\/\*?$/, '') || '/';
  if (e === '/' || e === '/*') return true;
  return e === home || SYSTEM_DIRS.has(e) || /^\/home\/[^/]+$/.test(e);
}

/** Past assignments, keywords and wrappers (`sudo -u root`, `timeout 5`, `env X=1`, `xargs -0`): the real command. */
function realCommand(words: string[]): string[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return [];
    if (/^[A-Za-z_]\w*=/.test(w) || KEYWORDS.has(w)) { i++; continue; }
    const name = w.replace(/^.*\//, '');
    const opts = WRAPPERS[name];
    if (!opts) return [name, ...words.slice(i + 1)];
    i++;
    while (words[i]?.startsWith('-') && words[i] !== '--') { if (opts.has(words[i]!)) i++; i++; }
    if (words[i] === '--') i++;
    if (name === 'timeout' && words[i] !== undefined) i++; // the duration
  }
}

function checkSimple(words: string[], home: string, depth: number): string | null {
  const [cmd, ...args] = realCommand(words);
  if (!cmd) return null;
  if (/^(?:ba|z|da|k)?sh$/.test(cmd)) {
    const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    return c >= 0 && args[c + 1] !== undefined ? checkLine(args[c + 1]!, home, depth + 1) : null;
  }
  if (cmd === 'rm') {
    const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
    return recursive && args.some(a => !a.startsWith('-') && isRoot(a, home)) ? REFUSE.rm : null;
  }
  if (/^mkfs(?:\.\w+)?$/.test(cmd)) return REFUSE.mkfs;
  if (cmd === 'dd') return args.some(a => a.startsWith('of=') && BLOCK_DEVICE.test(a.slice(3))) ? REFUSE.dd : null;
  if (['shutdown', 'reboot', 'poweroff', 'halt'].includes(cmd)) return REFUSE.power;
  if (cmd === 'systemctl') {
    const verb = args.find(a => !a.startsWith('-'));
    return verb && ['poweroff', 'reboot', 'halt', 'kexec'].includes(verb) ? REFUSE.power : null;
  }
  if ((cmd === 'init' || cmd === 'telinit') && ['0', '6'].includes(args[0] ?? '')) return REFUSE.power;
  return null;
}

function checkLine(command: string, home: string, depth = 0): string | null {
  if (depth > 4) return null;
  if (FORK_BOMB.test(command)) return REFUSE.fork;
  let toks: Tok[];
  try { toks = lex(command); } catch { return null; }
  let words: string[] = [];
  const flush = (): string | null => { const r = checkSimple(words, home, depth); words = []; return r; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    for (const sub of t.subs ?? []) { const r = checkLine(sub, home, depth + 1); if (r) return r; }
    if (t.w !== undefined) { words.push(t.w); continue; }
    if (SEPARATORS.has(t.op!)) { const r = flush(); if (r) return r; continue; }
    const next = toks[i + 1];
    if (next?.w === undefined) continue;
    i++; // a redirection's operand is never a command word
    for (const sub of next.subs ?? []) { const r = checkLine(sub, home, depth + 1); if (r) return r; }
    if (WRITE_REDIRECTS.has(t.op!) && BLOCK_DEVICE.test(next.w)) return REFUSE.dd;
  }
  return flush();
}

/** The refusal for a tool call, or null. Only Bash runs commands; files are the checkout guard's business (guard.ts). */
export function checkAuthority(input: { tool_name?: unknown; tool_input?: unknown }, home = homedir()): string | null {
  if (input.tool_name !== 'Bash') return null;
  const command = (input.tool_input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return null;
  const why = checkLine(command, home);
  return why
    ? `Permission authority refused this: ${why}. This class of command is never auto-approved `
      + '(company/directives.md, Authority). If it is really needed, ask the owner directly.'
    : null;
}
