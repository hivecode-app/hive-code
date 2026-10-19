// SessionStart additionalContext (B.3.3): built from shiftDir/prime.json,
// which the shift-host/hq writes ahead of time. Never talks to hq.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirp } from './spool.ts';
import { ADDITIONAL_CONTEXT_CAP, PRIME_BUDGETS } from '@company/shared';
import type { PrimeFile } from '@company/shared';

export const TRUNCATION_MARK = '…[קוצץ, ראה recall]';

const SECTIONS: ReadonlyArray<{ key: keyof typeof PRIME_BUDGETS; heading: string }> = [
  { key: 'handoff', heading: '## העברה מהמשמרת הקודמת' },
  { key: 'directives', heading: '## הוראות חדשות' },
  { key: 'topRecord', heading: '## הרשומה הרלוונטית ביותר' },
  { key: 'memoryIndex', heading: '## אינדקס זיכרון' },
  { key: 'inbox', heading: '## הודעות שלא טופלו' },
  { key: 'pointers', heading: '## מצביעים' },
];

/**
 * Cuts `text` to at most `max` chars including the truncation mark, at a line
 * boundary when one exists in the second half of the kept part.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const mark = '\n' + TRUNCATION_MARK;
  const room = max - mark.length;
  if (room <= 0) return TRUNCATION_MARK.slice(0, Math.max(0, max));
  let kept = text.slice(0, room);
  const nl = kept.lastIndexOf('\n');
  if (nl >= room / 2) kept = kept.slice(0, nl);
  return kept.trimEnd() + mark;
}

export function buildAdditionalContext(prime: PrimeFile, source: string): string {
  const parts: string[] = [
    `# הקשר משמרת · זהות: ${prime.identity} · משמרת: ${prime.shift} · source: ${source || 'unknown'} · עודכן: ${prime.updatedAt}`,
  ];
  for (const { key, heading } of SECTIONS) {
    const body = prime[key];
    if (typeof body !== 'string' || !body.trim()) continue;
    parts.push(`${heading}\n${truncate(body.trim(), PRIME_BUDGETS[key])}`);
  }
  return truncate(parts.join('\n\n'), ADDITIONAL_CONTEXT_CAP);
}

export function primePath(stateRoot: string, shift: string): string {
  return `${stateRoot}/shifts/${shift}/prime.json`;
}

/** Returns null if the file is missing or not an object; throws on invalid JSON. */
export function readPrimeFile(stateRoot: string, shift: string): PrimeFile | null {
  let raw: string;
  try { raw = readFileSync(primePath(stateRoot, shift), 'utf8'); } catch { return null; }
  const p = JSON.parse(raw) as PrimeFile;
  if (typeof p !== 'object' || p === null) return null;
  return p;
}

/** Atomic write: tmp file in the same dir, then rename. */
export function writePrimeFile(stateRoot: string, shift: string, prime: PrimeFile): string {
  const file = primePath(stateRoot, shift);
  mkdirp(`${stateRoot}/shifts/${shift}`);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(prime));
  renameSync(tmp, file);
  return file;
}
