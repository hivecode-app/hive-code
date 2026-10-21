import { readFileSync } from 'node:fs';

/**
 * Every assistant text block of the turn that just ended, in order: the transcript lines after the last user
 * prompt (a user line that is not just tool results). `last_assistant_message` is only the block after the last
 * tool, and text written earlier in the turn already streamed to the owner. Unreadable transcript → [].
 */
export function turnTexts(transcriptPath: unknown): string[] {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return [];
  let lines: string[];
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return []; }
  let out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (o?.type === 'user' && !o.isSidechain) {
      const toolResultsOnly = Array.isArray(content) && content.length > 0 && content.every((b: any) => b?.type === 'tool_result');
      if (!toolResultsOnly) out = [];
    } else if (o?.type === 'assistant' && !o.isSidechain && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push(b.text);
    }
  }
  return out;
}
