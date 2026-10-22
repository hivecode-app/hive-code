import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
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

test('docker: שלבי הניקוי מדווחים את שינוי הדיסק בפועל, מדמון מדומה', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${dir}/calls"
case "$1" in
  info) echo 29.1.3;;
  builder) printf 'ID\\tRECLAIMABLE\\nabc\\ttrue\\nTotal:\\t2GB\\n';;
  image) echo 'Total reclaimed space: 1GB';;
esac
`, { mode: 0o755 });
  let u = 10 * 1024 ** 3;
  const usedFn = () => (u -= 1024 ** 3); // every call looks like 1GB went away
  const home = mkdtempSync(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtempSync(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, usedFn, tmpOnly: true });
  const cache = r.steps.find((s) => s.name === 'docker build cache');
  const img = r.steps.find((s) => s.name === 'docker images');
  assert.equal(cache.freed, 1024 ** 3);
  assert.match(cache.note, /docker דיווח 2\.0GB, הדיסק כולו \(לא רק docker\) השתנה ב-1\.0GB/);
  assert.match(img.note, /docker דיווח 1\.0GB/);
  const calls = readFileSync(join(dir, 'calls'), 'utf8');
  assert.match(calls, /builder prune -af --filter until=6h/);
  assert.match(calls, /image prune -af --filter until=24h/);
});

test('docker: דמון לא נגיש נרשם כשלב docker עם הערה, בלי ניקוי', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\necho "permission denied on docker.sock" >&2\nexit 1\n`, { mode: 0o755 });
  const home = mkdtempSync(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtempSync(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, tmpOnly: true });
  assert.match(r.steps.find((s) => s.name === 'docker').note, /הדמון לא נגיש.*permission denied/);
});

test('docker: בלי docker במכונה אין שלב docker ואין כשל', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtempSync(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: join(home, 'no-docker'), tmpOnly: true });
  assert.equal(r.steps.some((s) => s.name.startsWith('docker')), false);
});

test('docker: prune שנכשל נרשם עם השגיאה', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in info) echo 29.1.3;; *) echo "boom" >&2; exit 1;; esac\n`, { mode: 0o755 });
  const home = mkdtempSync(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtempSync(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, usedFn: () => 0, tmpOnly: true });
  assert.match(r.steps.find((s) => s.name === 'docker images').note, /נכשל: boom/);
});
