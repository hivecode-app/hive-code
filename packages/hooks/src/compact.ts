// PostCompact compact_summary -> handoff candidate (bet 1): keep only the
// <summary> part (drop <analysis>) and cut it to the 4K handoff budget.
import { renameSync, writeFileSync } from 'node:fs';
import { PRIME_BUDGETS } from '@company/shared';
import { truncate } from './prime.ts';
import { mkdirp } from './spool.ts';

export function compactSummaryToHandoff(summary: string, max: number = PRIME_BUDGETS.handoff): string {
  let s = summary;
  const m = /<summary>([\s\S]*?)(?:<\/summary>|$)/i.exec(s);
  if (m) s = m[1]!;
  else s = s.replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/gi, '');
  return truncate(s.trim(), max);
}

/** Writes shiftDir/compact-handoff.md atomically (read by hq / prime writer). */
export function writeCompactHandoff(shiftDir: string, summary: string): string {
  mkdirp(shiftDir);
  const p = `${shiftDir}/compact-handoff.md`;
  writeFileSync(`${p}.tmp.${process.pid}`, compactSummaryToHandoff(summary));
  renameSync(`${p}.tmp.${process.pid}`, p);
  return p;
}
