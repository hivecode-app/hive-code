import { test } from 'node:test';
import assert from 'node:assert/strict';
import { englishLines, hebrewLines, isEnglishTitle, isWrongLanguageTitle, languageReason, wrongLanguageLines } from '../src/index.ts';

test('englishLines: English prose is caught, Hebrew with technical terms and code is not (#51)', () => {
  assert.equal(englishLines('Done. PR #52 is merged, CI is green and the deploy went fine.').length, 1);
  assert.equal(englishLines("I'm done, the PR's ready. Don't merge it yet, please.").length, 1);
  assert.equal(englishLines('well-known self-hosted re-run of the end-to-end tests is done').length, 1);
  assert.equal(englishLines('Done — PR #52 merged, CI green, רן approved the deploy last night').length, 1, 'one Hebrew word does not make it Hebrew');
  for (const ok of [
    'הרצתי npm test ו-typecheck על ה-worktree של company-t13 ב-hq-host, והכול עבר',
    'PR #17 מוזג. ה-CI ירוק, והבדיקה company-ci עברה על ה-commit האחרון',
    '```\nError: something went wrong in the build pipeline step\n```',
    '`npm run check:contract && npm test && npm run typecheck`',
    'ראו https://github.com/hivecode-app/hive-code/pull/52/files#diff-something-long',
    'OK, SOCKET-OK',
    'הרצתי npm run typecheck, npm test, npm run check:contract',
    'השגיאה: TypeError: Cannot read properties of undefined',
  ]) assert.deepEqual(englishLines(ok), [], ok);
});

test('isEnglishTitle: the t11 and t12 titles are English, Hebrew titles with terms pass', () => {
  assert.equal(isEnglishTitle('Tab handoff into hq, and browser_ask_user uses it'), true);
  assert.equal(isEnglishTitle('Implement the רצף logo as the app icon'), true);
  assert.equal(isEnglishTitle('Fix login flow'), true);
  for (const ok of ['העברת ה-handoff של הטאב ל-hq', 'תיקון ל-company-ci ב-PR', '#22 מצב לילה וסיכום בוקר', 'pretest: לזהות @company/shared שנטען מחוץ ל-worktree', 'CI',
    'מחקר: Claude Code hooks API', 'fix: Stop hook ב-cli'])
    assert.equal(isEnglishTitle(ok), false, ok);
});

test('wrongLanguageLines: by the owner\'s language, he blocks English prose and en blocks Hebrew prose', () => {
  const en = 'Done. PR #52 is merged, CI is green and the deploy went fine.';
  const he = 'PR #52 מוזג, ה-CI ירוק והפריסה עברה בלי תקלות';
  assert.equal(wrongLanguageLines(en, 'he').length, 1);
  assert.deepEqual(wrongLanguageLines(he, 'he'), []);
  assert.equal(wrongLanguageLines(he, 'en').length, 1);
  assert.deepEqual(wrongLanguageLines(en, 'en'), []);
  for (const ok of ["Merged, and רן's logo is in the app now", 'Ran `npm test` on the branch: green', 'OK']) assert.deepEqual(hebrewLines(ok), [], ok);
  assert.equal(isWrongLanguageTitle('תיקון ההתחברות בטלפון', 'en'), true);
  assert.equal(isWrongLanguageTitle('Fix the phone login', 'en'), false);
  assert.equal(isWrongLanguageTitle('Fix the phone login', 'he'), true);
  assert.match(languageReason('tell.body', [en], 'he'), /must be in Hebrew/);
  assert.match(languageReason('tell.body', [he], 'en'), /must be in English/);
});
