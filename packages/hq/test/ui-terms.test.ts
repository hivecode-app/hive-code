// The fixed text hq writes into the interface has no internal term (owner, 08/11: «ראשי תיבות המעצבנים האלה וכל מיני
// מונחים כמו גו»). The dictionary is packages/shared/src/ui-terms.json; the app's copy test reads the same one for the ARB.
// Text a worker writes (headline, summary) is not checked here: the tool descriptions ask for his words instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UI_TERMS, uiTermHits } from '@company/shared';
import { systemCopy, notificationTitle } from '../src/i18n.ts';
import { sentence, type HomeFacts } from '../src/home.ts';
import { goHeadline } from '../src/ingest.ts';
import { defaultToggles, Store } from '../src/store.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const clean = (where: string, text: string, lang?: 'he' | 'en') => assert.deepEqual(uiTermHits(text, lang), [], `${where}: ${text}`);

test('the dictionary: every pattern compiles in u mode, and each term catches what it names', () => {
  assert.ok(UI_TERMS.length >= 20);
  for (const t of UI_TERMS) {
    assert.ok(t.he && t.en && t.match.length, t.term);
    for (const m of t.match) new RegExp(m.re, m.i ? 'iu' : 'u');
  }
  for (const [text, term] of [['מחכה ל-GO', 'GO'], ['נפתח PR', 'PR'], ['ה-CI ירוק', 'CI'], ['באג p1', 'p0–p3'], ['מחכה לפריסה', 'deploy'],
    ['מוזג', 'merge'], ['ב-worktree', 'worktree'], ['task-1234', 'task-1234'], ['גיבוי hq.db', 'hq'], ['תקלה בפרודקשן', 'production']] as const) {
    assert.ok(uiTermHits(text, 'he').includes(term), `${term} in ${text}`);
  }
  assert.deepEqual(uiTermHits('בתור · {p0} · release · פורסם'), [], 'a placeholder, "release" and "פורסם" are not terms');
  assert.deepEqual(uiTermHits('Sign in with a passkey', 'en'), []);
  assert.deepEqual(uiTermHits('כניסה עם passkey', 'he'), ['passkey']);
});

test('system copy, notification titles, the home sentence and the switches say it in his words', () => {
  for (const [key, v] of Object.entries(systemCopy)) { clean(`systemCopy.${key}.he`, v.he, 'he'); clean(`systemCopy.${key}.en`, v.en, 'en'); }
  for (const action of ['release', 'deploy', 'publish', 'run', undefined]) {
    clean(`goHeadline ${action}`, goHeadline(action, 'עדכון האפליקציה'), 'he');
    clean(`goHeadline ${action}`, goHeadline(action, 'the app update'), 'en');
  }
  for (const language of ['he', 'en'] as const) {
    for (const kind of ['go', 'ask', 'login'] as const) clean(`notificationTitle ${kind}`, notificationTitle({ kind, title: 'עדכון', headline: null }, language), language);
  }
  const base: HomeFacts = { waiting: 0, running: 0, where: [], done: 0, visited: true, stuck: 0 };
  const facts: Partial<HomeFacts>[] = [
    {}, { stuck: 2 }, { running: 3, where: ['לומו', 'החברה'] }, { done: 4, visited: false },
    ...['go', 'ask', 'login', 'incident'].map((kind) => ({ waiting: 1, decision: { kind, text: 'עדכון האפליקציה' } })),
    { waiting: 1, decision: { kind: 'go', text: 'GO: עדכון האפליקציה' } },
    { waiting: 3, gos: 1, decision: { kind: 'go', text: 'עדכון', first: true } }, { waiting: 3, gos: 1, decision: { kind: 'go', text: 'עדכון' } },
    { waiting: 3, gos: 1 }, { waiting: 2, gos: 2 }, { waiting: 3, gos: 3 }, { waiting: 4, gos: 2, running: 1, done: 2 },
  ];
  for (const f of facts) clean(`sentence ${JSON.stringify(f)}`, sentence({ ...base, ...f }), 'he');
  for (const t of defaultToggles('יואב')) clean(`toggle ${t.key}`, t.description, 'he');
});

test('the Android notification text (Wording.kt, Channels.kt) is in his words too', () => {
  const dir = join(import.meta.dirname, '../../app/android/app/src/main/kotlin/app/hivecode/notify');
  for (const file of ['Wording.kt', 'Channels.kt']) {
    const literals = [...readFileSync(join(dir, file), 'utf8').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).filter((x) => !/^[a-z_]*$/.test(x)); // a channel id or a kind is protocol
    assert.ok(literals.length > 0, file);
    for (const x of literals) clean(file, x.replace(/\$\{[^}]*\}|\$\w+/g, ' '), 'he');
  }
});

test('a store opened again takes the new wording of a switch, and keeps whether it is on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-terms-'));
  try {
    const path = join(dir, 'hq.db');
    const first = new Store(path);
    const key = defaultToggles('יואב')[0]!.key;
    first.db.prepare('UPDATE toggles SET description = ?, enabled = 1 - enabled WHERE key = ?').run('גיבוי hq.db כל שעה', key);
    const flipped = (first.db.prepare('SELECT enabled FROM toggles WHERE key = ?').get(key) as { enabled: number }).enabled;
    first.db.close();
    const again = new Store(path);
    const row = again.db.prepare('SELECT enabled, description FROM toggles WHERE key = ?').get(key) as { enabled: number; description: string };
    again.db.close();
    assert.equal(row.description, defaultToggles('יואב')[0]!.description);
    assert.equal(row.enabled, flipped, 'his choice stays');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the Android disconnect notification is the ARB text: server_connection.xml is generated, and not left behind', () => {
  const app = join(import.meta.dirname, '../../app');
  const pairs = [['server_silent_title', 'serverSilentTitle'], ['server_silent_body', 'serverSilentBody'], ['server_silent_channel', 'serverSilentChannel']];
  for (const [language, folder] of [['en', 'values'], ['he', 'values-he']]) {
    const arb = JSON.parse(readFileSync(join(app, `lib/l10n/app_${language}.arb`), 'utf8')) as Record<string, string>;
    const xml = readFileSync(join(app, `android/app/src/main/res/${folder}/server_connection.xml`), 'utf8');
    for (const [key, value] of pairs) {
      const m = xml.match(new RegExp(`<string name="${key}">([^<]*)</string>`));
      const unescape = (x: string) => x.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      assert.equal(unescape(m?.[1] ?? ''), arb[value], `${folder}/${key}: run tool/generate_server_copy.py`);
    }
  }
});
