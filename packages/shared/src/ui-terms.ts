// Internal terms that never reach the interface (owner, 08/11: «ראשי תיבות המעצבנים האלה וכל מיני מונחים כמו גו»).
// One dictionary, ui-terms.json, read here, by the app's copy test and by the MCP tool descriptions.
import { readFileSync } from 'node:fs';

export interface UiTerm { term: string; he: string; en: string; match: { re: string; i?: boolean; lang?: 'he' | 'en' }[] }

export const UI_TERMS: UiTerm[] = (JSON.parse(readFileSync(new URL('./ui-terms.json', import.meta.url), 'utf8')) as { terms: UiTerm[] }).terms;

/** The terms a fixed interface text uses, after its placeholders ({p0}, {title}) are removed. */
export function uiTermHits(text: string, lang?: 'he' | 'en'): string[] {
  const plain = text.replace(/\{[^{}]*\}/g, ' ');
  return UI_TERMS.filter((t) => t.match.some((m) => (!m.lang || !lang || m.lang === lang) && new RegExp(m.re, m.i ? 'iu' : 'u').test(plain))).map((t) => t.term);
}

/** For the tool descriptions: "GO ← אישור · PR ← שינוי בקוד · …", the terms that have a word of their own. */
export function uiTermsLine(): string {
  return UI_TERMS.filter((t) => !t.he.startsWith('(')).map((t) => `${t.term} ← ${t.he}`).join(' · ');
}
