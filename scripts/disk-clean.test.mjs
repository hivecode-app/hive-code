import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickTmp, parseBytes, clean } from './disk-clean.mjs';

const e = (name, recent = false) => ({ name, recent });

test('pickTmp: משימה פתוחה או שנסגרה לפני פחות מיממה נשארת; סגורה ישנה נמחקת', () => {
  const closed = new Set([121, 49, 9]);
  const out = pickTmp([e('t121'), e('t347'), e('rev49'), e('task-400'), e('t1.1'), e('rev218-ci.log'), e('audit-1'), e('other'), e('t9', true), e('audit-2', true)], closed);
  assert.deepEqual(out, ['t121', 'rev49', 'audit-1']);
});

test('parseBytes', () => {
  assert.equal(parseBytes('Total reclaimed space: 1.5GB'), 1.5 * 1024 ** 3);
  assert.equal(parseBytes('0B'), 0);
  assert.equal(parseBytes('אין'), null);
});

test('clean מוחק רק /tmp ישן של משימה סגורה, לא נוגע בסימלינק ובפתוחה', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dc-'));
  const home = mkdtempSync(join(tmpdir(), 'dch-'));
  const old = new Date(Date.now() - 3 * 86400_000);
  for (const n of ['t121', 't347', 'audit-x', 'keepme']) {
    mkdirSync(join(tmp, n)); writeFileSync(join(tmp, n, 'f'), 'x'.repeat(5000));
    utimesSync(join(tmp, n, 'f'), old, old); utimesSync(join(tmp, n), old, old);
  }
  symlinkSync(join(tmp, 'keepme'), join(tmp, 't500'));
  writeFileSync(join(tmp, 't121.1'), 'file'); utimesSync(join(tmp, 't121.1'), old, old);
  const r = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [121], tmpOnly: true });
  assert.equal(existsSync(join(tmp, 't121')), false);
  assert.equal(existsSync(join(tmp, 'audit-x')), false);
  assert.equal(existsSync(join(tmp, 't347')), true);
  assert.equal(existsSync(join(tmp, 'keepme')), true);
  assert.equal(existsSync(join(tmp, 't500')), true);
  assert.equal(existsSync(join(tmp, 't121.1')), true, 'קובץ ששמו דומה אינו של משימה');
  assert.ok(r.steps.find((s) => s.name.startsWith('/tmp')));
  const dry = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [121], dryRun: true, tmpOnly: true });
  assert.equal(dry.dry, true);
});

test('בלי רשימת משימות פתוחות ובלי hq.db: מדלגים על /tmp', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dc-'));
  const home = mkdtempSync(join(tmpdir(), 'dch-'));
  mkdirSync(join(tmp, 't121'));
  const old = new Date(Date.now() - 3 * 86400_000); utimesSync(join(tmp, 't121'), old, old);
  await clean({ tmp, home, stateDir: join(home, 's'), dryRun: true, tmpOnly: true });
  const r = await clean({ tmp, home, stateDir: join(home, 's'), tmpOnly: true });
  assert.equal(existsSync(join(tmp, 't121')), true);
  assert.match(r.steps.at(-1).note, /מדלג/);
});
