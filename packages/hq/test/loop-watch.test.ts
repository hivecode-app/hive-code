// hq's event loop stalls (packages/hq/src/loop-watch.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopWatch, type StallReport } from '../src/loop-watch.ts';
import { until } from './helpers.ts';

const spin = (ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { /* hq frozen */ } };

test('a freeze past the threshold is reported once, with what ran during it', async () => {
  const reports: StallReport[] = [];
  const w = new LoopWatch((r) => reports.push(r), { stallMs: 200, checkMs: 50 });
  w.start();
  try {
    const before = w.begin('loop done-before'); before();
    await new Promise((r) => setTimeout(r, 300)); // that one ended long before the stall
    const waiting = w.begin('loop waiting'); // an async loop still awaiting
    const heavy = w.begin('GET /api/home');
    spin(400);
    heavy();
    await until(() => reports.length > 0, 5000, 'stall reported');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reports.length, 1);
    const [r] = reports;
    assert.ok(r!.ms >= 350, `ms ${r!.ms}`);
    assert.equal(r!.ran[0]!.what, 'GET /api/home');
    assert.ok(r!.ran[0]!.ms >= 390 && !r!.ran[0]!.open, `ran ${JSON.stringify(r!.ran)}`); // two clocks, rounded
    assert.ok(r!.ran.some((a) => a.what === 'loop waiting' && a.open));
    assert.ok(!r!.ran.some((a) => a.what === 'loop done-before'));
    assert.ok((r!.resources.Timeout ?? 0) >= 1);
    waiting();
  } finally { w.stop(); }
});

test('short pauses are not stalls', async () => {
  const reports: StallReport[] = [];
  const w = new LoopWatch((r) => reports.push(r), { stallMs: 300, checkMs: 50 });
  w.start();
  try {
    for (let i = 0; i < 3; i++) { spin(60); await new Promise((r) => setTimeout(r, 60)); }
    assert.equal(reports.length, 0);
  } finally { w.stop(); }
});
