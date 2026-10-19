import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeSegments, emptyArchive, ingestLine, pendingQueued } from '../src/index.ts';

test('consumeSegments: in order, whole lines, each occurrence once', () => {
  assert.deepEqual(consumeSegments('continue\nok', ['continue', 'continue']), [0]);
  assert.deepEqual(consumeSegments('continue\ncontinue', ['continue', 'continue']), [0, 1]);
  assert.deepEqual(consumeSegments('look at this', ['ok']), []);
  assert.deepEqual(consumeSegments('b\na', ['a', 'b']), [0]);      // order: after "a" nothing follows
  assert.deepEqual(consumeSegments('multi\nline msg\nnext', ['multi\nline msg', 'next']), [0, 1]);
});

test('pendingQueued keeps one of two duplicates when the merged line carries one', () => {
  const a = emptyArchive('s', null);
  const L = (o: unknown) => ingestLine(a, JSON.stringify(o));
  L({ type: 'queue-operation', operation: 'enqueue', content: 'continue' });
  L({ type: 'queue-operation', operation: 'enqueue', content: 'continue' });
  L({ type: 'queue-operation', operation: 'enqueue', content: 'ok' });
  L({ type: 'user', uuid: 'u', message: { role: 'user', content: 'continue\nok' } });
  assert.deepEqual(pendingQueued(a), ['continue']);
});
