import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '@company/adapter';
import { ShiftHost } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '../../adapter/test/fixtures/fake-claude.mjs');
chmodSync(FAKE, 0o755);

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('crash with a queued message: CLI-held message is not failed, and is matched by content after resume (bet 2)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ri-'));
  const cfg = join(root, 'claude-config');
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const cwd = join(root, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const sessionId = 'sess-ri-1';
    const mk = (onExit: (c: number) => void) => new ShiftHost({
      spec: { identity: 't', shift: 'ri-1', sessionId, resume: false, cwd, settingsFile: '', stateRoot: root, claudeBin: FAKE,
        env: { FAKE_CLAUDE_TURN_MS: '4000' } },
      lingerMs: 10, onExit,
    });
    const log = () => readFileSync(join(root, 'shifts/ri-1.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    let exited1: () => void = () => {};
    const done1 = new Promise<void>((r) => { exited1 = r; });
    const h1 = mk(() => exited1());
    await h1.start();
    const send = (h: ShiftHost, id: string, text: string) =>
      (h as unknown as { send: (a: string, b: string, c: string, d: boolean) => unknown }).send(id, text, 'next', false);
    send(h1, 'm-1', 'first message');
    send(h1, 'm-2', 'second message, queued');
    await until(() => log().some((f) => f.t === 'delivery' && f.msgId === 'm-2' && f.state === 'delivered'));
    // what the real CLI persists: an unconsumed enqueue of m-2's content
    const pdir = join(cfg, 'projects', projectSlug(cwd));
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'first message' }),
      JSON.stringify({ type: 'user', uuid: 'x', message: { role: 'user', content: 'first message' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'second message, queued' }),
    ].join('\n') + '\n');
    h1.claude!.killGroup('SIGKILL');
    await done1;
    const l1 = log();
    const exit = l1.find((f) => f.t === 'lifecycle' && f.state === 'exited');
    assert.deepEqual(exit.heldByCli, ['m-2']);
    assert.equal(exit.error, 'no_result');
    assert.ok(l1.some((f) => f.t === 'delivery' && f.msgId === 'm-1' && f.state === 'failed' && f.error === 'interrupted mid-turn'));
    assert.ok(!l1.some((f) => f.t === 'delivery' && f.msgId === 'm-2' && f.state === 'failed'));

    // restart: our log shows the session started -> auto --resume; m-2 is re-injected by the CLI
    const h2 = mk(() => {});
    await h2.start();
    assert.equal(h2.spec.resume, true);
    assert.ok(log().some((f) => f.t === 'delivery' && f.msgId === 'm-2' && f.reinjected === true));
    // the CLI's merged re-injection arrives with a new uuid
    (h2 as unknown as { onEngineEvent: (e: unknown) => void }).onEngineEvent({ kind: 'user_echo', uuid: 'new-uuid', text: 'second message, queued' });
    assert.ok(log().some((f) => f.t === 'delivery' && f.msgId === 'm-2' && f.state === 'started'));
    // hq resending m-2 is a no-op
    const r = send(h2, 'm-2', 'second message, queued') as { state: string };
    assert.equal(r.state, 'started');
    await h2.stop(500);
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  }
});
