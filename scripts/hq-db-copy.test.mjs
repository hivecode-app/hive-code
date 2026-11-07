// Task 1531: `company db-copy` writes a whole, readable copy of hq.db under db-copies/<identity>/, and refuses when the disk is short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { dbCopy } from './hq-db-copy.mjs';

function state() {
  const d = mkdtempSync(join(tmpdir(), 'dbcopy-'));
  const db = new Database(join(d, 'hq.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id TEXT); INSERT INTO messages VALUES (\'a\'), (\'b\');');
  return { d, db };
}

test('a copy under db-copies/<identity>/, with what is in the WAL, 0600', async () => {
  const { d, db } = state();
  try {
    const out = await dbCopy({ state: d, identity: 'proj-t7', now: new Date('2026-11-08T05:00:00Z'), free: () => 100 * 1024 ** 3 });
    assert.equal(out, join(d, 'db-copies', 'proj-t7', 'hq-20261108T050000Z.db'));
    const c = new Database(out, { readonly: true });
    assert.equal(c.prepare('SELECT COUNT(*) n FROM messages').get().n, 2);
    c.close();
    assert.equal(statSync(out).mode & 0o777, 0o600);
  } finally { db.close(); rmSync(d, { recursive: true, force: true }); }
});

test('no room, or no identity: no copy, and the read-only way is in the message', async () => {
  const { d, db } = state();
  try {
    await assert.rejects(dbCopy({ state: d, identity: 'proj-t7', free: () => 1024 ** 3 }), /mode=ro/);
    assert.deepEqual(readdirSync(join(d, 'db-copies', 'proj-t7')), []);
    await assert.rejects(dbCopy({ state: d, identity: '' }), /identity/);
    await assert.rejects(dbCopy({ state: d, identity: '../x' }), /identity/);
  } finally { db.close(); rmSync(d, { recursive: true, force: true }); }
});
