import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, symlinkSync, readFileSync, rmSync, openSync, closeSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickTmp, byName, heldUnder, parseBytes, clean } from './disk-clean.mjs';

const made = [];
const mkdtemp = (prefix) => { const d = mkdtempSync(prefix); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

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
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const old = new Date(Date.now() - 3 * 86400_000);
  for (const n of ['t121', 't347', 'audit-x', 'keepme']) {
    mkdirSync(join(tmp, n)); writeFileSync(join(tmp, n, 'f'), 'x'.repeat(5000));
    utimesSync(join(tmp, n, 'f'), old, old); utimesSync(join(tmp, n), old, old);
  }
  symlinkSync(join(tmp, 'keepme'), join(tmp, 't500'));
  writeFileSync(join(tmp, 't121.1'), 'file'); utimesSync(join(tmp, 't121.1'), old, old);
  const r = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [121], tmpOnly: true, proc: null }); // only the step of tasks
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
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  mkdirSync(join(tmp, 't121'));
  const old = new Date(Date.now() - 3 * 86400_000); utimesSync(join(tmp, 't121'), old, old);
  await clean({ tmp, home, stateDir: join(home, 's'), dryRun: true, tmpOnly: true });
  const r = await clean({ tmp, home, stateDir: join(home, 's'), tmpOnly: true });
  assert.equal(existsSync(join(tmp, 't121')), true);
  assert.match(r.steps.find((s) => s.name === '/tmp של משימות').note, /מדלג/);
});

test('docker: שלבי הניקוי מדווחים את שינוי הדיסק בפועל, מדמון מדומה', async () => {
  const dir = mkdtemp(join(tmpdir(), 'dcd-'));
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
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, usedFn, tmpOnly: true });
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
  const dir = mkdtemp(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\necho "permission denied on docker.sock" >&2\nexit 1\n`, { mode: 0o755 });
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, tmpOnly: true });
  assert.match(r.steps.find((s) => s.name === 'docker').note, /הדמון לא נגיש.*permission denied/);
});

test('docker: בלי docker במכונה אין שלב docker ואין כשל', async () => {
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: join(home, 'no-docker'), tmpOnly: true });
  assert.equal(r.steps.some((s) => s.name.startsWith('docker')), false);
});

test('docker: prune שנכשל נרשם עם השגיאה', async () => {
  const dir = mkdtemp(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in info) echo 29.1.3;; *) echo "boom" >&2; exit 1;; esac\n`, { mode: 0o755 });
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, usedFn: () => 0, tmpOnly: true });
  assert.match(r.steps.find((s) => s.name === 'docker images').note, /נכשל: boom/);
});

test('docker logs: לוג של קונטיינר רץ מעל 1GB נחתך ל-0, קטן נשאר, כשלים נרשמים', async () => {
  const dir = mkdtemp(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  // inspect prints what exists and exits 1, as when a --rm container went away after ps
  writeFileSync(bin, `#!/bin/sh
case "$1" in
  info) echo 29.1.3;;
  ps) printf 'c1\\nc2\\nc3\\nc4\\nc5\\nc6\\n';;
  inspect) printf '/big\\t${dir}/big.log\\n/small\\t${dir}/small.log\\n/gone\\t${dir}/gone.log\\n/blank\\t${dir}/blank.log\\n/ro\\t${dir}/ro.big.log\\n/journald\\t\\n'; echo 'error: no such object: c6' >&2; exit 1;;
esac
`, { mode: 0o755 });
  // a fake sudo: it insists on -n, takes the size from the name, records truncate
  const sudo = join(dir, 'sudo');
  writeFileSync(sudo, `#!/bin/sh
[ "$1" = -n ] || { echo "no -n" >&2; exit 9; }
shift
case "$1" in
  stat) case "$4" in *ro.big.log|*/big.log) echo 2147483648;; *small.log) echo 1048576;; *blank.log) echo;; *) echo "no such file" >&2; exit 1;; esac;;
  truncate) case "$4" in *ro.big.log) echo "read-only" >&2; exit 1;; *) echo "$4" >> "${dir}/cut";; esac;;
esac
`, { mode: 0o755 });
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, sudoBin: sudo, usedFn: () => 0, tmpOnly: true });
  const step = r.steps.find((s) => s.name === 'docker logs');
  assert.equal(step.freed, 2 * 1024 ** 3);
  assert.match(step.note, /^נחתכו: \/big 2\.0GB · לא נחתכו: \/ro 2\.0GB \(read-only\) · לא נבדקו: inspect \(error: no such object: c6\), \/gone \(no such file\), \/blank \(אין גודל\)$/);
  assert.equal(readFileSync(join(dir, 'cut'), 'utf8'), `${join(dir, 'big.log')}\n`);
  const dry = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, sudoBin: sudo, dryRun: true, tmpOnly: true });
  assert.equal(dry.steps.find((s) => s.name === 'docker logs').note, 'dry-run');
  assert.equal(readFileSync(join(dir, 'cut'), 'utf8').split('\n').length, 2, 'dry-run לא חותך');
});

test('docker logs: inspect שנכשל בלי פלט נרשם, לא "אין לוג"', async () => {
  const dir = mkdtemp(join(tmpdir(), 'dcd-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in info) echo 29.1.3;; ps) echo c1;; inspect) echo "daemon gone" >&2; exit 1;; esac\n`, { mode: 0o755 });
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const r = await clean({ tmp: mkdtemp(join(tmpdir(), 'dc-')), home, stateDir: join(home, 's'), closedTasks: [], dockerBin: bin, sudoBin: join(dir, 'no-sudo'), usedFn: () => 0, tmpOnly: true });
  assert.equal(r.steps.find((s) => s.name === 'docker logs').note, 'docker inspect נכשל: daemon gone');
});

test('byName: לא שמות של שירות חי, של המערכת, של משימות או ה-caches עצמם', () => {
  const ok = ['hq-abc', 'mongo-mem-x', 'f.log', 'rev-112', 'lumo_bg_deliveryAB'];
  const no = ['.X11-unix', '.com.google.Chrome.x', 'systemd-private-1-x', 'tmux-1001', 'ssh-abc', 'com.google.Chrome.x', 'chrome-personal',
    'playwright-artifacts-1', 't121', 'rev49', 'audit-1', 'claude-1001', 'tsx-1001', 'node-compile-cache'];
  assert.deepEqual(ok.filter((n) => byName(n, 1001)), ok);
  assert.deepEqual(no.filter((n) => byName(n, 1001)), []);
});

test('heldUnder: cwd, קובץ פתוח ו-socket של תהליך חי נחשבים מוחזקים', { skip: !existsSync('/proc/self/fd') }, async () => {
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  mkdirSync(join(tmp, 'cwd')); mkdirSync(join(tmp, 'sockdir')); mkdirSync(join(tmp, 'open'));
  writeFileSync(join(tmp, 'open', 'f'), 'x');
  const p = spawn('sleep', ['30'], { cwd: join(tmp, 'cwd'), stdio: 'ignore' });
  const fd = openSync(join(tmp, 'open', 'f'), 'r');
  const srv = createServer().listen(join(tmp, 'sockdir', 's'));
  await new Promise((r) => srv.once('listening', r));
  try {
    const h = heldUnder(tmp);
    assert.ok(h.has(join(tmp, 'cwd')), 'cwd');
    assert.ok([...h].some((x) => x.startsWith(join(tmp, 'sockdir'))), 'socket');
    assert.ok(h.has(join(tmp, 'open', 'f')), 'קובץ פתוח');
  } finally { p.kill(); srv.close(); closeSync(fd); }
  assert.equal(heldUnder(tmp, join(tmp, 'no-proc')), null);
});

// ctime cannot be set back, so these run at `now` three days ahead: what is made here is old, and "fresh" is set to then.
const LATER = Date.now() + 3 * 86400_000;

test('clean: פריט ישן ושקט נמחק; קובץ חדש עמוק בפנים, תהליך מחזיק, שירות חי, socket ו-cache שומרים', { skip: !existsSync('/proc/self/fd') }, async () => {
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const uid = process.getuid();
  const fresh = new Date(LATER);
  const dir = (rel) => { mkdirSync(join(tmp, rel), { recursive: true }); writeFileSync(join(tmp, rel, 'f'), 'x'.repeat(8192)); };
  for (const n of ['hq-leak', 'deep/a/b', 'held', 'systemd-private-x', 'playwright-artifacts-1', '.hidden', `claude-${uid}/old-proj`, `claude-${uid}/new-proj`, 't347']) dir(n);
  writeFileSync(join(tmp, 'deep/a/b/new'), 'x'); utimesSync(join(tmp, 'deep/a/b/new'), fresh, fresh); // fresh, two levels down: all of deep stays
  writeFileSync(join(tmp, `claude-${uid}/new-proj/g`), 'x'); utimesSync(join(tmp, `claude-${uid}/new-proj/g`), fresh, fresh);
  writeFileSync(join(tmp, 'old.log'), 'x');
  const outside = mkdtemp(join(tmpdir(), 'dc-'));
  writeFileSync(join(outside, 'precious'), 'x');
  symlinkSync(outside, join(tmp, 'hq-leak', 'link')); // a link inside an old entry: the link goes, not what it points at
  const srv = createServer().listen(join(tmp, 'live.sock'));
  await new Promise((r) => srv.once('listening', r));
  const p = spawn('sleep', ['30'], { cwd: join(tmp, 'held'), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  try {
    const dry = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [], tmpOnly: true, dryRun: true, now: LATER });
    assert.equal(existsSync(join(tmp, 'hq-leak')), true, 'dry-run מוחק כלום');
    assert.match(dry.steps.find((s) => s.name === '/tmp ישן').note, /^3 פריטים/);
    const r = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [], tmpOnly: true, now: LATER });
    for (const gone of ['hq-leak', 'old.log', `claude-${uid}/old-proj`]) assert.equal(existsSync(join(tmp, gone)), false, gone);
    assert.equal(existsSync(join(outside, 'precious')), true, 'היעד של קישור בפנים נשאר');
    for (const kept of ['deep/a/b/f', 'held', 'systemd-private-x', 'playwright-artifacts-1', '.hidden', 'live.sock', `claude-${uid}/new-proj`, 't347']) assert.equal(existsSync(join(tmp, kept)), true, kept);
    assert.ok(r.steps.find((s) => s.name === '/tmp ישן').freed >= 8192);
  } finally { p.kill(); srv.close(); }
});

test('clean: ctime חדש (עץ ישן שהגיע עכשיו ב-mv או tar) שומר', { skip: !existsSync('/proc/self/fd') }, async () => {
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  const old = new Date(Date.now() - 3 * 86400_000);
  mkdirSync(join(tmp, 'arrived')); writeFileSync(join(tmp, 'arrived', 'f'), 'x');
  utimesSync(join(tmp, 'arrived', 'f'), old, old); utimesSync(join(tmp, 'arrived'), old, old); // mtime old, ctime now
  const r = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [], tmpOnly: true });
  assert.equal(existsSync(join(tmp, 'arrived', 'f')), true);
  assert.match(r.steps.find((s) => s.name === '/tmp ישן').note, /^0 פריטים/);
});

test('clean: מחיקה שנכשלת באמצע נספרת בהערה', { skip: !existsSync('/proc/self/fd') || process.getuid() === 0 }, async () => {
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  mkdirSync(join(tmp, 'stuck', 'ro'), { recursive: true }); writeFileSync(join(tmp, 'stuck', 'ro', 'f'), 'x');
  chmodSync(join(tmp, 'stuck', 'ro'), 0o500);
  try {
    const r = await clean({ tmp, home, stateDir: join(home, 's'), closedTasks: [], tmpOnly: true, now: LATER });
    assert.match(r.steps.find((s) => s.name === '/tmp ישן').note, /^0 פריטים.*1 לא נמחקו עד הסוף \(EACCES\)/);
  } finally { chmodSync(join(tmp, 'stuck', 'ro'), 0o700); }
});

test('clean: mount של קונטיינר docker רץ שומר; ps שנכשל או קונטיינר עם כל /tmp מדלגים על השלב', { skip: !existsSync('/proc/self/fd') }, async () => {
  const tmp = mkdtemp(join(tmpdir(), 'dc-'));
  const home = mkdtemp(join(tmpdir(), 'dch-'));
  for (const n of ['mounted', 'loose']) { mkdirSync(join(tmp, n)); writeFileSync(join(tmp, n, 'f'), 'x'); }
  const fake = (body) => { const dir = mkdtemp(join(tmpdir(), 'dcd-')); const bin = join(dir, 'docker'); writeFileSync(bin, `#!/bin/sh\ncase "$1" in info) echo 29.1.3;; ${body} esac\n`, { mode: 0o755 }); return bin; };
  const opts = { tmp, home, stateDir: join(home, 's'), closedTasks: [], tmpOnly: true, now: LATER, usedFn: () => 0, dryRun: true };
  const step = async (bin) => (await clean({ ...opts, dockerBin: bin })).steps.find((s) => s.name === '/tmp ישן').note;
  assert.match(await step(fake('ps) exit 1;;')), /לא ידוע מה קונטיינרים/);
  assert.match(await step(fake(`ps) echo c1;; inspect) echo ${tmp};;`)), /לא ידוע מה קונטיינרים/);
  assert.match(await step(fake('ps) echo c1;; inspect) echo /;;')), /לא ידוע מה קונטיינרים/);
  assert.match(await step(fake('ps) echo c1;; inspect) exit 1;;')), /לא ידוע מה קונטיינרים/);
  const note = await step(fake(`ps) echo c1;; inspect) echo ${join(tmp, 'mounted')}; echo /srv/x;;`));
  assert.match(note, /^1 פריטים.*loose$/);
});
