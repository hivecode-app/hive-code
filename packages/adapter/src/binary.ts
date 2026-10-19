// Pinned Claude Code binary (B.5 "binary", B.6 "pinned version").
// Layout: ~/.local/share/agent-company/claude/<ver>/claude   (private prefix)
//         ~/.local/share/agent-company/claude/current -> <ver>
// The owner's global install (~/.npm-global) is never used or modified.
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const PINNED_VERSION = '2.1.303';

export function claudeRoot(home = homedir()): string {
  return join(home, '.local/share/agent-company/claude');
}

export function resolveClaudeBin(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const env = opts.env ?? process.env;
  if (env.COMPANY_CLAUDE_BIN) return env.COMPANY_CLAUDE_BIN;
  const root = claudeRoot(opts.home);
  for (const p of [join(root, 'current', 'claude'), join(root, PINNED_VERSION, 'claude')]) {
    if (existsSync(p)) return p;
  }
  throw new Error(`pinned claude not found under ${root}; run scripts/install-claude.sh ${PINNED_VERSION}`);
}

export function binaryVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 15_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch { return null; }
}

export function currentPinned(home = homedir()): string | null {
  try { return readlinkSync(join(claudeRoot(home), 'current')); } catch { return null; }
}

export function realBin(bin: string): string {
  try { return realpathSync(bin); } catch { return bin; }
}
