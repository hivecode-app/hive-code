import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyArchive, ingestLine, pendingQueued, containsAsLines } from '../src/index.ts';

test('pendingQueued: ordered multiset, exact or whole-line match, no substring false positives', () => {
  const a = emptyArchive('s', null);
  const L = (o: unknown) => ingestLine(a, JSON.stringify(o));
  L({ type: 'queue-operation', operation: 'enqueue', content: 'continue' });
  L({ type: 'queue-operation', operation: 'enqueue', content: 'continue' });
  L({ type: 'queue-operation', operation: 'enqueue', content: 'ok' });
  L({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'continue' } });       // consumes ONE continue
  L({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'look at this' } });   // must not consume "ok"
  assert.deepEqual(pendingQueued(a), ['continue', 'ok']);
  L({ type: 'user', uuid: 'u3', message: { role: 'user', content: 'continue\nok' } });   // merged re-injection
  assert.deepEqual(pendingQueued(a), []);
  assert.equal(containsAsLines('look', 'ok'), false);
  assert.equal(containsAsLines('a\nok\nb', 'ok'), true);
});

test('queued_command attachments consume like user lines', () => {
  const a = emptyArchive('s', null);
  ingestLine(a, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'mid-turn note' }));
  ingestLine(a, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'mid-turn note' } }));
  assert.deepEqual(pendingQueued(a), []);
});
