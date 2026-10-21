// Which running tool his `now` may cut (adi, 21/10/2026: an allowlist, not a blocklist). Reading, searching,
// tests and builds lose nothing when stopped; anything else (an edit, a deploy, git push, a migration, an MCP
// call, a sub-agent, a Bash line we do not recognise) runs to its end, and his message goes in right after it.

const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

/** One Bash command (no pipes or `&&`): what reads, tests or builds and changes nothing outside its output. */
const SAFE_COMMANDS: RegExp[] = [
  /^npm (test|t)( .*)?$/,
  /^npm run (test|typecheck|build|lint|check:contract)( .*)?$/,
  /^(npx )?tsc( .*)?$/,
  /^node --test( .*)?$/,
  /^(\S*\/)?flutter (test|analyze)( .*)?$/,
  /^git (status|log|diff|show|fetch)( .*)?$/,
  /^(ls|cat|head|tail|wc|grep|rg|pwd|sleep)( .*)?$/,
  /^cd( \S+)?$/,
];

/** Redirections that only drop or merge output; any other `>` writes a file. */
const HARMLESS_REDIRECT = /\s*(\d?>\s*\/dev\/null|2>&1)/g;

export function safeBash(command: string): boolean {
  const line = command.replace(HARMLESS_REDIRECT, '').replace(/&&/g, ';').replace(/\$HOME\b/g, '~');
  // Substitution or expansion ($…, {a,b}), a redirect into a file, a heredoc or a lone `&` (a second command in the
  // background) can hide anything behind a safe-looking start. $HOME alone is a path.
  if (/[`<>&${]/.test(line)) return false;
  // Flags that run a program or write a file from inside a reading command, also quoted ('--pre', \--output) and
  // abbreviated as git takes them (--upload-p, --ou).
  if (/(^|\s)(--pre(=|\s|$)|--?(up|rec|ou|ext|exec))/.test(line.replace(/['"\\]/g, ''))) return false;
  const parts = line.split(/\|\||[;|\n]/).map((p) => p.trim());
  return parts.length > 0 && parts.every((p) => p !== '' && SAFE_COMMANDS.some((re) => re.test(p)));
}

export function safeToInterrupt(tool: { name: string; input?: unknown }): boolean {
  if (SAFE_TOOLS.has(tool.name)) return true;
  if (tool.name !== 'Bash') return false;
  const cmd = (tool.input as { command?: unknown } | undefined)?.command;
  return typeof cmd === 'string' && safeBash(cmd);
}
