// Hebrew everywhere (dir-0002, issue #51): one check shared by the per-shift Stop hook and the
// company MCP tools. Code, paths and URLs are stripped first; technical terms inside a Hebrew
// sentence are fine. Port of ~/.claude/hooks/hebrew-reply-guard.mjs, which shifts do not load
// (they run with --setting-sources project,local).


/** Prose without code blocks, inline code, URLs and paths. */
export function stripTechnical(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.-]*\/[\w./-]+/g, ' ');
}

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const HEB_WORD = /[\u05D0-\u05EA]+/g;
/** A plain English word ("merged", "Done,", "don't", "re-run"). Identifiers (check:contract, TypeError, CI, t13, a_b) are not counted. */
const PLAIN_WORD = /^[("'«]*([A-Z]?[a-z]+(?:['’-][A-Za-z]+)*)[)"'»,.;:!?…]*$/;
const TOOL_WORDS = new Set(['npm', 'npx', 'git', 'gh', 'node', 'tsc', 'sudo', 'cd', 'ls', 'cat', 'grep', 'sed', 'curl', 'ssh']);

function englishWords(s: string): string[] {
  return s.split(/\s+/).map((t) => PLAIN_WORD.exec(t)?.[1]).filter((w): w is string => !!w && !TOOL_WORDS.has(w.toLowerCase()));
}

/**
 * Mostly English: at least `minLatin` letters of plain English words, and fewer than one Hebrew word per `ratio`
 * English words. A Hebrew name inside an English sentence ("…רן approved the deploy") is still English;
 * a Hebrew sentence with an English error message or tool names in it is not.
 */
function mostlyEnglish(s: string, minLatin: number, ratio: number): boolean {
  const en = englishWords(s);
  return en.join('').length >= minLatin && count(s, HEB_WORD) * ratio < en.length;
}

/** Lines of running text that are English (messages, replies). */
export function englishLines(text: string, minLatin = 25): string[] {
  return stripTechnical(text).split('\n').filter((l) => mostlyEnglish(l, minLatin, 5)).map((l) => l.trim());
}

/** A short title (task, ticket) that is English: a stricter ratio, since a title has few words. */
export function isEnglishTitle(title: string, minLatin = 8): boolean {
  return mostlyEnglish(stripTechnical(title), minLatin, 3);
}

/** The fix-it text a worker gets back. */
export function hebrewReason(what: string, bad: string[]): string {
  const sample = bad.slice(0, 3).map((l) => `  ${l.slice(0, 100)}`).join('\n');
  return `${what} חייב להיות בעברית (dir-0002). באנגלית:\n${sample}\n`
    + 'כתוב שוב בעברית. שמות קבצים, פקודות, מזהים ומונחים טכניים יכולים להישאר כמו שהם, בתוך `backticks`.';
}
