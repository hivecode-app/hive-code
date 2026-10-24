import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeEnv } from './helpers.ts';
import { backupOnce, pruneBackups, restoreBackup } from '../src/backup.ts';
import { Store } from '../src/store.ts';

const HOUR = 3_600_000;

test('backup: a compressed snapshot, restored and opened, holds what hq had', async () => {
  const env = await makeEnv();
  try {
    const dir = join(env.cfg.stateDir, 'backups');
    env.hq.mailbox.tell({ msg_id: 'b-1', to: 'owner', from: 'eli', body: 'לגיבוי' });
    const file = await backupOnce(env.hq.store, dir, { hourly: 24, daily: 7 });
    assert.match(file, /hq-2026-10-20T090000Z\.db\.zst$/);
    assert.deepEqual(readdirSync(dir), ['hq-2026-10-20T090000Z.db.zst'], 'no temp file left, no raw copy');
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const out = join(env.dir, 'restored.db');
    const r = await restoreBackup(file, out);
    assert.ok(r.messages >= 1);
    const copy = new Store(out);
    assert.equal((copy.db.prepare(`SELECT body FROM messages WHERE id = 'b-1'`).get() as { body: string }).body, 'לגיבוי');
    copy.close();
    await assert.rejects(restoreBackup(file, out), /already exists/, 'never over an existing file');
  } finally { await env.cleanup(); }
});

test('backup: a broken backup does not restore, and leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    writeFileSync(join(dir, 'hq-2026-10-20T090000Z.db'), 'not sqlite at all');
    await assert.rejects(restoreBackup(join(dir, 'hq-2026-10-20T090000Z.db'), join(dir, 'out.db')));
    writeFileSync(join(dir, 'bad.db.zst'), 'not zstd');
    await assert.rejects(restoreBackup(join(dir, 'bad.db.zst'), join(dir, 'out.db')));
    assert.deepEqual(readdirSync(dir).sort(), ['bad.db.zst', 'hq-2026-10-20T090000Z.db']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backup: keeps the newest 24 hourly and the newest of each of the last 7 days', async () => {
  const env = await makeEnv();
  try {
    const dir = join(env.cfg.stateDir, 'backups');
    // 10 days of hourly backups, from 20/10 09:00.
    for (let i = 0; i < 240; i++) { await backupOnce(env.hq.store, dir, { hourly: 24, daily: 7 }); env.clock.advance(HOUR); }
    const files = readdirSync(dir).sort();
    // Last backup: 30/10 08:00. Hourly: 29/10 09:00 … 30/10 08:00. Daily: the 23:00 of 24/10…28/10 (29 and 30 are in the hourly).
    assert.equal(files.length, 24 + 5);
    assert.equal(files.at(-1), 'hq-2026-10-30T080000Z.db.zst');
    assert.equal(files[5], 'hq-2026-10-29T090000Z.db.zst');
    assert.deepEqual(files.slice(0, 5), ['24', '25', '26', '27', '28'].map((d) => `hq-2026-10-${d}T230000Z.db.zst`));
  } finally { await env.cleanup(); }
});

test('backup-prune: raw backups from before are cut to the policy and compressed; leftovers go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    const raw = (name: string) => {
      const db = new Database(join(dir, name));
      db.exec(`CREATE TABLE messages (id TEXT); INSERT INTO messages VALUES ('${name}')`);
      db.close();
      utimesSync(join(dir, name), 1000, 1000); // written long ago: a raw one from the last 10 minutes is left for the next run
    };
    for (let h = 0; h < 30; h++) raw(`hq-2026-10-24T${String(h % 24).padStart(2, '0')}0000Z.db`.replace('24T', h < 24 ? '23T' : '24T'));
    for (let i = 0; i < 5; i++) {
      raw(`hq-before-v1.${i}.0-2026102${i}T000000Z.db`);
      utimesSync(join(dir, `hq-before-v1.${i}.0-2026102${i}T000000Z.db`), 1000 + i, 1000 + i);
    }
    writeFileSync(join(dir, 'hq-2026-10-21T114917Z.db-shm'), '');
    writeFileSync(join(dir, 'hq-2026-10-21T114917Z.db-wal'), '');
    writeFileSync(join(dir, 'other-project.json'), '{}');
    raw('hq-before-v2.0.0-20261025T000000Z.db');
    utimesSync(join(dir, 'hq-before-v2.0.0-20261025T000000Z.db'), new Date(), new Date()); // company-update.sh is writing it

    const r = await pruneBackups(dir, { hourly: 4, daily: 2 });
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, [
      'hq-2026-10-23T230000Z.db.zst', // daily of 23/10 (24/10 is in the hourly)
      'hq-2026-10-24T020000Z.db.zst', 'hq-2026-10-24T030000Z.db.zst', 'hq-2026-10-24T040000Z.db.zst', 'hq-2026-10-24T050000Z.db.zst',
      'hq-before-v1.3.0-20261023T000000Z.db.zst', 'hq-before-v1.4.0-20261024T000000Z.db.zst', 'hq-before-v2.0.0-20261025T000000Z.db',
      'other-project.json',
    ]);
    assert.equal(r.compressed.length, 7, '5 hourly and 2 hq-before; the one being written waits');
    const out = join(dir, 'x.db');
    assert.equal((await restoreBackup(join(dir, 'hq-2026-10-24T050000Z.db.zst'), out)).messages, 1);
    assert.equal((new Database(out).prepare('SELECT id FROM messages').get() as { id: string }).id, 'hq-2026-10-24T050000Z.db');
    // Again: nothing more to do.
    rmSync(out);
    assert.deepEqual(await pruneBackups(dir, { hourly: 4, daily: 2 }), { deleted: [], compressed: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backup-prune: two runs at once (hq hourly and a manual one) both finish, and the result is whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    for (let h = 0; h < 6; h++) {
      const name = `hq-2026-10-24T0${h}0000Z.db`;
      const db = new Database(join(dir, name));
      db.exec(`CREATE TABLE messages (id TEXT); INSERT INTO messages VALUES ('${name}')`);
      db.close();
      utimesSync(join(dir, name), 1000, 1000);
    }
    await Promise.all([pruneBackups(dir, { hourly: 3, daily: 1 }), pruneBackups(dir, { hourly: 3, daily: 1 })]);
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['hq-2026-10-24T030000Z.db.zst', 'hq-2026-10-24T040000Z.db.zst', 'hq-2026-10-24T050000Z.db.zst']);
    for (const f of files) assert.equal((await restoreBackup(join(dir, f), join(dir, `${f}.out`))).messages, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
