import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LineSplitter, decodeHqFrame, decodeHostFrame, encodeFrame, ProtocolError,
  SHIFT_PROTOCOL_VERSION, statePaths, shiftSocketPath, shiftLogPath,
} from '../src/index.ts';

test('paths follow B.11 layout', () => {
  const p = statePaths('/home/u');
  assert.equal(shiftSocketPath(p, 'yoav-3'), '/home/u/.local/state/agent-company/shifts/yoav-3.sock');
  assert.equal(shiftLogPath(p, 'yoav-3'), '/home/u/.local/state/agent-company/shifts/yoav-3.ndjson');
});

test('encode/decode roundtrip for hq frames', () => {
  const f = { t: 'send', id: 'c1', msgId: 'm-1', text: 'שלום', priority: 'later' } as const;
  assert.deepEqual(decodeHqFrame(encodeFrame(f).trim()), f);
});

test('send without priority defaults to next', () => {
  const f = decodeHqFrame('{"t":"send","id":"c","msgId":"m","text":"x"}');
  assert.equal(f.t === 'send' && f.priority, 'next');
});

test('hq frame validation', () => {
  assert.throws(() => decodeHqFrame('{"t":"nope"}'), ProtocolError);
  assert.throws(() => decodeHqFrame('[1]'), ProtocolError);
  assert.throws(() => decodeHqFrame('{"t":"send","id":"c"}'), ProtocolError);
  assert.throws(() => decodeHqFrame(`{"t":"hello","v":${SHIFT_PROTOCOL_VERSION + 1},"client":"hq","logId":null,"since":0}`), ProtocolError);
});

test('unknown host frames are skipped, not fatal', () => {
  assert.equal(decodeHostFrame('{"t":"future_thing","x":1}'), null);
  const ev = decodeHostFrame('{"t":"event","seq":4,"ts":"x","ev":{"kind":"text","text":"hi"}}');
  assert.equal(ev?.t, 'event');
});

test('LineSplitter handles partial chunks and multibyte splits', () => {
  const lines: string[] = [];
  const s = new LineSplitter((l) => lines.push(l));
  const bytes = new TextEncoder().encode('{"a":"שלום"}\n{"b":2}\n{"c"');
  s.push(bytes.slice(0, 7));   // splits inside a Hebrew code point
  s.push(bytes.slice(7));
  s.push(':3}');
  s.end();
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 'שלום' }, { b: 2 }, { c: 3 }]);
});

test('LineSplitter drops an oversized line and resyncs at the next newline', () => {
  const lines: string[] = [];
  let overflows = 0;
  const s = new LineSplitter((l) => lines.push(l), 10, () => overflows++);
  s.push('x'.repeat(20));
  s.push('yyy\n{"ok":1}\n');
  assert.deepEqual(lines, ['{"ok":1}']);
  assert.equal(overflows, 1);
  assert.throws(() => new LineSplitter(() => {}, 10).push('z'.repeat(20)), ProtocolError);
});

test('LineSplitter delivers every complete line even if onLine throws', () => {
  const lines: string[] = [];
  const s = new LineSplitter((l) => { lines.push(l); if (l === 'a') throw new Error('boom'); });
  assert.throws(() => s.push('a\nb\nc\n'), /boom/);
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('hello validation', () => {
  assert.throws(() => decodeHqFrame('{"t":"hello"}'), ProtocolError);
  assert.throws(() => decodeHqFrame('{"t":"hello","v":1,"since":"5"}'), ProtocolError);
  assert.throws(() => decodeHqFrame('{"t":"interrupt"}'), ProtocolError);
  assert.throws(() => decodeHqFrame('{"t":"spool_ack","id":"a"}'), ProtocolError);
  const h = decodeHqFrame('{"t":"hello","v":1,"since":0}');
  assert.equal(h.t === 'hello' && h.logId, null);
  try { decodeHqFrame('{"t":"hello","v":2,"since":0}'); assert.fail(); }
  catch (e) { assert.equal((e as ProtocolError).code, 'version'); }
});

test('logged host frames require seq', () => {
  assert.throws(() => decodeHostFrame('{"t":"event","ts":"x","ev":{}}'), ProtocolError);
  assert.throws(() => decodeHostFrame('{"t":"reply","ok":true}'), ProtocolError);
});
