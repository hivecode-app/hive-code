import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShiftHost } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '../../adapter/test/fixtures/fake-claude.mjs');
chmodSync(FAKE, 0o755);

function mk(root: string, shift: string, sessionId = 'S-' + shift) {
  const cwd = join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  let exited: (c: number) => void = () => {};
  const done = new Promise<number>((r) => { exited = r; });
  const host = new ShiftHost({
    spec: { identity: 't', shift, sessionId, resume: false, cwd, settingsFile: '', stateRoot: root, claudeBin: FAKE },
    lingerMs: 50, onExit: (c) => exited(c),
  });
  const log = () => readFileSync(join(root, 'shifts', `${shift}.ndjson`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const send = (id: string, text: string) =>
    (host as unknown as { send: (a: string, b: string, c: string, d: boolean) => unknown }).send(id, text, 'next', false);
  return { host, done, log, send };
}

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('a requested stop exits 0 so systemd does not resurrect it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lc1-'));
  const s = mk(root, 'lc-1');
  await s.host.start();
  s.send('m-1', 'hi');
  await until(() => s.log().some((f) => f.t === 'delivery' && f.state === 'completed'));
  await s.host.stop(1000);
  assert.equal(await s.done, 0);
});

test('auto-resume only for the session this log started; another session id starts fresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lc2-'));
  const a = mk(root, 'lc-2');
  await a.host.start();
  a.send('m-1', 'hi');
  await until(() => a.log().some((f) => f.t === 'event' && f.ev.kind === 'init'));
  await a.host.stop(1000);
  await a.done;
  const b = mk(root, 'lc-2');
  await b.host.start();
  assert.equal(b.host.spec.resume, true);
  await b.host.stop(1000);
  await b.done;
  const c = mk(root, 'lc-2', 'OTHER-SESSION');
  await c.host.start();
  assert.equal(c.host.spec.resume, false);
  await c.host.stop(1000);
  await c.done;
});
