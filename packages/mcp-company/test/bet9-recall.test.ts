// Bet-9 recall replay: 20 Hebrew questions vs the owner's (mostly English)
// memory corpus. Needs the real corpus + the keywords cache, so it skips in CI.
//   BET9_NO_KEYWORDS=1  measure without the keyword bridge (prints, no assert)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addNameStopWords, bet9Sources, createIndex, defaultStateRoot, keywordCachePath, loadKeywordCache, loadRecords, openL3, sha1, tokenize, variants,
} from '../src/l3.ts';

interface Q { id: number; project: string; q: string; src: string }
const QUESTIONS = JSON.parse(readFileSync(new URL('./fixtures/bet9-questions.json', import.meta.url), 'utf8')) as Q[];

test('bet9: src record ranks in top 5 for >= 18/20 questions', (t) => {
  const sources = bet9Sources();
  if (!sources.length) { t.skip('no memoryImport in hq.config.json'); return; }
  const missing = sources.filter((s) => !existsSync(s.dir)).map((s) => s.dir);
  if (missing.length) { t.skip(`bet9 corpus absent (${missing.join(', ')})`); return; }
  const noKw = process.env.BET9_NO_KEYWORDS === '1';
  const stateRoot = defaultStateRoot();
  if (!noKw && !existsSync(keywordCachePath(stateRoot))) {
    t.skip(`keywords cache absent (${keywordCachePath(stateRoot)}); run scripts/memory-keywords.mjs`); return;
  }
  const records = loadRecords(sources, noKw ? {} : loadKeywordCache(stateRoot));
  if (!noKw && !records.some((r) => r.keywordsHe.length)) {
    t.skip('keywords cache has no entry for the bet9 corpus; run scripts/memory-keywords.mjs --bet9'); return;
  }
  addNameStopWords(join(import.meta.dirname, '..', '..', '..', 'company')); // as recall does, from org.yaml
  const idx = createIndex(records);
  let rank1 = 0, top5 = 0;
  const rows: string[] = [];
  for (const q of QUESTIONS) {
    const hits = idx.search([q.q], { project: q.project, limit: 50 });
    const rank = hits.findIndex((h) => h.record.id === q.src) + 1;
    if (rank === 1) rank1++;
    if (rank >= 1 && rank <= 5) top5++;
    const verdict = rank === 1 ? 'body injected' : rank >= 1 && rank <= 5 ? 'in index' : 'MISS';
    rows.push(`#${String(q.id).padStart(2)} rank ${rank ? String(rank).padStart(2) : ' -'}  ${verdict.padEnd(13)} ${q.src}  (top: ${hits[0]?.record.id ?? '-'})`);
  }
  const withKw = records.filter((r) => r.keywordsHe.length).length;
  t.diagnostic(`records=${records.length} withKeywords=${withKw} keywords=${noKw ? 'off' : 'on'}`);
  for (const r of rows) t.diagnostic(r);
  t.diagnostic(`rank1=${rank1}/20 top5=${top5}/20`);
  if (!noKw) assert.ok(top5 >= 18, `top-5 hits ${top5}/20 < 18`);
});

test('tokenizer: stopwords dropped, Hebrew prefixes stripped as variants', () => {
  assert.deepEqual(tokenize('מה המספר של ביטוח הבריאות?'), ['המספר', 'ביטוח', 'הבריאות']);
  assert.ok(variants('הבריאות').includes('בריאות'));
  assert.ok(variants('שהבוט').includes('בוט'));
  assert.ok(variants('texts').includes('text'));
});

test('synthetic bilingual corpus: Hebrew query reaches an English record only via keywords', () => {
  const root = mkdtempSync(join(tmpdir(), 'l3-'));
  const mem = join(root, 'repo', 'memory');
  mkdirSync(join(mem, 'projects', 'lumo'), { recursive: true });
  mkdirSync(join(mem, 'company'), { recursive: true });
  const ins = '---\nname: health-insurance\ndescription: "Health insurance policy, emergency line +000 0 000 0000"\n---\nDeductible EUR 100.\n';
  writeFileSync(join(mem, 'company', 'health-insurance.md'), ins);
  writeFileSync(join(mem, 'company', 'MEMORY.md'), '- index, skipped');
  writeFileSync(join(mem, 'projects', 'lumo', 'no-guillemets.md'),
    '---\nname: no-guillemets\ndescription: "Never use French quotes in product text"\nkeywords_he: [מרכאות, גרשיים, ציטוט]\n---\nUse plain text.\n');
  writeFileSync(join(mem, 'projects', 'lumo', 'bot-texts.md'), '---\nname: bot-texts\ndescription: "Bot strings live in i18n files"\n---\nbody\n');

  const state = join(root, 'state');
  const before = openL3({ repo: join(root, 'repo'), stateRoot: state, extraSources: [] });
  assert.deepEqual(before.records.map((r) => r.id).sort(), ['company/health-insurance', 'projects/lumo/bot-texts', 'projects/lumo/no-guillemets']);
  assert.equal(before.get('no-guillemets')?.scope, 'project:lumo');
  assert.equal(before.search(['מה מספר החירום של ביטוח הבריאות?']).length, 0);
  // frontmatter keywords bridge with no cache
  assert.equal(before.search(['אילו מרכאות אסור לשים?'])[0]?.record.id, 'projects/lumo/no-guillemets');

  mkdirSync(join(state, 'memory'), { recursive: true });
  writeFileSync(join(state, 'memory', 'keywords.json'),
    JSON.stringify({ [sha1(ins)]: { he: ['ביטוח בריאות', 'חירום', 'השתתפות עצמית'], en: ['insurance', 'deductible'] } }));
  const after = openL3({ repo: join(root, 'repo'), stateRoot: state, extraSources: [] });
  const hits = after.search(['מה מספר החירום של ביטוח הבריאות?', 'health insurance emergency number']);
  assert.equal(hits[0]?.record.id, 'company/health-insurance');

  const prime = after.selectForPrime('צריך לדעת מה ההשתתפות העצמית בביטוח', 'lumo');
  assert.match(prime.topRecord, /^### company\/health-insurance/);
  assert.ok(prime.topRecord.length <= 1800 && prime.index.length <= 1000);
  assert.match(prime.index, /lumo\/bot-texts/);
});
