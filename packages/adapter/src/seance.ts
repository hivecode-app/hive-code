// Seance (B.3.2 source 3): a read-only fork of a dead shift writes the handoff.
// Bet 1: the forked session could not read schema.yaml ("read-only session")
// and guessed fields, so the schema is embedded inline in the prompt.

export const HANDOFF_SCHEMA_YAML = `identity: <id>
shift: <n>
ended: <ISO time>
reason: rotation|compact|crash|machine_move|account_switch|task_done
task: {ref: <repo#issue>, title: <title>, branch: <branch>, pr: <number|null>}
state: "<up to 3 sentences: where things stand right now>"
done: ["<fact, with ref (commit/PR/file)>"]
decisions:
  - {what: "<decision>", why: "<reason>", by: owner|self|manager, ref: <msg id|null>}
next: ["<next concrete step>"]
waiting_on: [{who: <owner|identity>, item: <ask id or text>}]
open_questions: ["<question>"]
directives_seen_upto: <dir id|null>
warnings: ["<trap the next shift must know>"]
confidence: <0..1, your honest estimate>`;

export function seancePrompt(identity: string, shiftNo: number | string, reason = 'crash'): string {
  return [
    'You are reading the transcript of a work shift that ended abruptly. Do not run any tools that change files.',
    `Write the handoff for the next shift of "${identity}" (shift ${shiftNo}, reason: ${reason}).`,
    'Output ONLY YAML that follows this schema exactly (all keys, in this order; use [] or null when unknown):',
    '```yaml', HANDOFF_SCHEMA_YAML, '```',
    'Rules: decisions said by the owner must be quoted faithfully, including any decision that was later changed (keep only the latest, mention the change in why).',
    'Mark a step done only if the transcript shows it finished (file written, command succeeded). A step that was in flight when the shift died is NOT done.',
    'Keep it under 4000 characters.',
  ].join('\n');
}

/** Extracts the YAML body from a fenced or bare reply. */
export function extractYaml(reply: string): string {
  const m = /```(?:yaml)?\n([\s\S]*?)```/.exec(reply);
  return (m ? m[1]! : reply).trim();
}
