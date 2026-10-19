import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShiftHost } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '../../adapter/test/fixtures/fake-claude.mjs');
chmodSync(FAKE, 0o755);

function mk(root: string, shift: string, env: Record<string, string> = {}, bin = FAKE) {
  const cwd = join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  let exited: (c: number) => void = () => {};
  const done = new Promise<number>((r) => { exited = r; });
  const host = new ShiftHost({
    spec: { identity: 't', shift, sessionId: 'S-' + shift, resume: false, cwd, settingsFile: '', stateRoot: root, claudeBin: bin, env },
    lingerMs: 50, onExit: (c) => exited(c),
  });
  return { host, done, log: () => readFileSync(join(root, 'shifts', `${shift}.ndjson`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('"Session ID already in use" is a visible crash, not an empty shift (bet 1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f1-'));
  const { host, done, log } = mk(root, 'f-1', { FAKE_CLAUDE_IN_USE: '1' });
  await host.start();
  await done;
  const exit = log().find((f) => f.t === 'lifecycle' && f.state === 'exited');
  assert.equal(exit.error, 'session_id_in_use');
});

test('missing binary: host reaches exited (spawn_failed) and shuts down', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f2-'));
  const { host, done, log } = mk(root, 'f-2', {}, join(root, 'no-such-claude'));
  await host.start();
  await done;
  const exit = log().find((f) => f.t === 'lifecycle' && f.state === 'exited');
  assert.equal(exit.error, 'spawn_failed');
});

test('claude dying mid-turn fails the started delivery and marks no_result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f3-'));
  const { host, done, log } = mk(root, 'f-3', { FAKE_CLAUDE_DIE_MIDTURN: '1' });
  await host.start();
  // drive it directly through the private send path via the protocol-free API
  (host as unknown as { send: (a: string, b: string, c: string, d: boolean) => unknown }).send('m-1', 'hi', 'next', false);
  await done;
  const l = log();
  const failed = l.find((f) => f.t === 'delivery' && f.msgId === 'm-1' && f.state === 'failed');
  assert.ok(failed, 'delivery failed');
  assert.equal(failed.error, 'interrupted mid-turn');
  assert.equal(l.find((f) => f.t === 'lifecycle' && f.state === 'exited').error, 'no_result');
});

test('retry does not resend an accepted message; second host on the same shift is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-'));
  const { host, log } = mk(root, 'f-4');
  await host.start();
  const send = (host as unknown as { send: (a: string, b: string, c: string, d: boolean) => { uuid: string; state: string } }).send.bind(host);
  const first = send('m-1', 'hi', 'next', false);
  await until(() => log().some((f) => f.t === 'delivery' && f.state === 'completed'));
  const again = send('m-1', 'hi', 'next', true);
  assert.equal(again.uuid, first.uuid);
  assert.equal(log().filter((f) => f.t === 'delivery' && f.state === 'written').length, 1);
  const second = mk(root, 'f-4');
  await assert.rejects(second.host.start(), /held by host pid|another shift-host/);
  await host.stop(1000);
});
