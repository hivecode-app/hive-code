// The owner's language everywhere (dir-0002, issue #51): the check behind the company MCP tools (`tell`, titles).
// The language is `owner_language` in org.yaml (he | en): with `he` English prose is sent back for a rewrite, with
// `en` Hebrew prose is. The worker instructions are English either way, so this guard is what keeps a Hebrew owner's
// conversation in Hebrew.
// The per-shift Stop hook no longer blocks on it (owner, 07/11: the block made duplicate replies). Code, paths and URLs are stripped first; technical terms inside a Hebrew
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

export type OwnerLanguage = 'he' | 'en';
export const LANGUAGE_NAME: Record<OwnerLanguage, string> = { he: 'Hebrew', en: 'English' };
export const ownerLanguage = (v: unknown): OwnerLanguage => (v === 'he' ? 'he' : 'en');

/**
 * Mostly Hebrew: at least `minHebrew` Hebrew words, and at least as many as plain English words. An English
 * sentence with a Hebrew name or term in it ("Merged, Ran's רצף logo is in") is still English.
 */
function mostlyHebrew(s: string, minHebrew: number): boolean {
  const he = count(s, HEB_WORD);
  return he >= minHebrew && he >= englishWords(s).length;
}

/** Lines of running text that are Hebrew (for an English-speaking owner). */
export function hebrewLines(text: string, minHebrew = 3): string[] {
  return stripTechnical(text).split('\n').filter((l) => mostlyHebrew(l, minHebrew)).map((l) => l.trim());
}

/** A short title (task, ticket) that is Hebrew. */
export function isHebrewTitle(title: string, minHebrew = 2): boolean {
  return mostlyHebrew(stripTechnical(title), minHebrew);
}

/** Lines that are not in the owner's language. */
export function wrongLanguageLines(text: string, language: OwnerLanguage): string[] {
  return language === 'he' ? englishLines(text) : hebrewLines(text);
}

/** A title that is not in the owner's language. */
export function isWrongLanguageTitle(title: string, language: OwnerLanguage): boolean {
  return language === 'he' ? isEnglishTitle(title) : isHebrewTitle(title);
}

/** The fix-it text a worker gets back (in English, like all worker instructions). */
export function languageReason(what: string, bad: string[], language: OwnerLanguage): string {
  const name = LANGUAGE_NAME[language];
  const sample = bad.slice(0, 3).map((l) => `  ${l.slice(0, 100)}`).join('\n');
  return `${what} must be in ${name}, the owner's language (\`owner_language\`, dir-0002). Not in ${name}:\n${sample}\n`
    + `Write it again in ${name}. File names, commands, identifiers and technical terms may stay as they are, in \`backticks\`.`;
}
