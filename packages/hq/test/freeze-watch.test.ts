// task 1505: hq froze for 11 minutes (08/11, 01:50-02:01) and nothing restarted it. These reproduce a freeze: a child
// process whose main thread is stuck in one synchronous call, as hq was in GET /api/home, and the worker thread that
// kills it; then the next hq tells him.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, ORG_YAML } from './helpers.ts';
import { Hq } from '../src/hq.ts';
import { FreezeWatch, freezeItem, type FreezeReport } from '../src/freeze-watch.ts';

const SRC = new URL('../src/freeze-watch.ts', import.meta.url).pathname;

/** A process that starts the watch, marks what it begins, and then blocks its event loop for `blockMs`. */
function frozenChild(file: string, armed: boolean, blockMs: number): Promise<{ code: number | null; signal: string | null; ms: number }> {
  const script = `
    import { FreezeWatch } from ${JSON.stringify(SRC)};
    const w = new FreezeWatch(${JSON.stringify(file)}, { freezeMs: 1500, checkMs: 100, beatMs: 100 });
    w.start(() => ${armed});
    setTimeout(() => {
      w.mark('GET /api/home');
      // One synchronous call that does not return: the event loop, the beat and every timer stop with it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
      process.exit(0);
    }, 300);
  `;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
    c.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - t0 }));
  });
}

test('a main thread stuck in a synchronous call is killed, and leaves what it was doing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-'));
  try {
    const file = join(dir, 'freeze.json');
    const r = await frozenChild(file, true, 30_000);
    assert.equal(r.signal, 'SIGKILL', 'killed, for systemd to restart');
    assert.ok(r.ms < 10_000, `within seconds of the threshold, not after the 30s block (${r.ms}ms)`);
    const rep = JSON.parse(readFileSync(file, 'utf8')) as FreezeReport;
    assert.equal(rep.last?.what, 'GET /api/home', 'the last thing it began');
    assert.ok(rep.silent_ms >= 1500, `${rep.silent_ms}`);
    assert.ok(rep.machine.mem_available_mb! > 0, 'the machine at that moment');

    const w = new FreezeWatch(file);
    assert.equal(w.takeReport()?.last?.what, 'GET /api/home');
    assert.equal(existsSync(file), false, 'taken once');
    assert.equal(w.takeReport(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('switched off: the same freeze is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-'));
  try {
    const file = join(dir, 'freeze.json');
    const r = await frozenChild(file, false, 2500);
    assert.equal(r.signal, null);
    assert.equal(r.code, 0, 'it ran to the end of its block');
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a short stall is not a freeze', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-'));
  try {
    const file = join(dir, 'freeze.json');
    const r = await frozenChild(file, true, 800);
    assert.equal(r.code, 0);
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const ORG = ORG_YAML.replace('      - {id: ci-host-heartbeat, what: heartbeat, enabled: false}',
  '      - {id: ci-host-heartbeat, what: heartbeat, enabled: false}\n      - {id: freeze-watch, what: hq קפא, enabled: true}');

test('the next hq tells him: one urgent item, from the automation\'s owner', async () => {
  const env = await makeEnv({ noStart: true, org: ORG });
  try {
    const at = env.clock.now();
    const rep: FreezeReport = { at, silent_ms: 666_000, pid: 426048, last: { what: 'GET /api/home', at: at - 666_000 },
      machine: { mem_available_mb: 1200, swap_free_mb: 100, load1: 107, psi: { memory: 61, io: 58, cpu: 30 } } };
    writeFileSync(env.hq.freezeWatch.file, JSON.stringify(rep));
    await env.hq.start({ listen: false, timers: false });
    const items = env.hq.inbox.open().filter((i) => i.kind === 'incident');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.urgency, 'urgent');
    assert.equal(items[0]!.from_identity, 'rotem');
    assert.equal(items[0]!.title, 'hq נתקע 666 שניות והופעל מחדש');
    assert.match(items[0]!.body, /מה שהעובדים כתבו חיכה אצלם ונכנס כשהוא חזר/);
    assert.match(items[0]!.body, /באותו רגע היו בשרת 1\.2GB זיכרון פנוי ו-0\.1GB פנויים ב-swap/);
    assert.doesNotMatch(items[0]!.body, /עמוס/, 'the numbers, no verdict on them');
    assert.equal(existsSync(env.hq.freezeWatch.file), false, 'told once');
    assert.equal((env.hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'hq.freeze'`).get() as { n: number }).n, 1);

    // It freezes again while the item is open (the machine still thrashing): the same item, with the count.
    await env.hq.stop();
    for (const n of [2, 3]) {
      const again = new Hq(env.cfg, { now: env.clock.now });
      try {
        env.clock.advance(60_000);
        writeFileSync(again.freezeWatch.file, JSON.stringify({ ...rep, at: env.clock.now(), silent_ms: 45_000 }));
        await again.start({ listen: false, timers: false });
        const now = again.inbox.open().filter((i) => i.kind === 'incident');
        assert.equal(now.length, 1, 'not a second item');
        assert.match(now[0]!.title, new RegExp(`^hq נתקע ${n} פעמים, האחרונה ב-`));
      } finally { await again.stop(); }
    }
  } finally { await env.cleanup(); }
});

test('freezeItem: what is not known is not said', () => {
  const t = freezeItem({ at: 0, silent_ms: 45_000, pid: 1, last: null, machine: { mem_available_mb: null, swap_free_mb: null, load1: null, psi: { memory: null, io: null, cpu: null } } }, () => '01:50');
  assert.equal(t.title, 'hq נתקע 45 שניות והופעל מחדש');
  assert.doesNotMatch(t.body, /GB|\?|null/);
});
