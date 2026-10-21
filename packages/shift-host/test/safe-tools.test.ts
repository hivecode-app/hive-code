import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineSplitter, encodeFrame, decodeHostFrame, type HostToHq, type HqToHost } from '@company/shared';
import { ShiftHost } from '../src/index.ts';
import { safeBash, safeToInterrupt } from '../src/safe-tools.ts';

test('safe to interrupt: an allowlist of reading, tests and builds; anything unknown is not', () => {
  for (const c of ['npm test', 'npm test 2>&1 | tail -20', 'cd packages/hq && node --test test/mailbox.test.ts',
    '$HOME/flutter/bin/flutter test test/chat_test.dart', 'flutter analyze', 'npx tsc --noEmit -p x', 'npm run typecheck',
    'git status --short; git log --oneline -5', 'git log --pretty=format:%h -3', 'tsc --preserveWatchOutput', 'git diff origin/main...HEAD', 'rg -n foo src | head', 'ls -la >/dev/null', 'sleep 30']) {
    assert.equal(safeBash(c), true, c);
  }
  for (const c of ['./deploy.sh', 'bash deploy/hq.sh', 'kubectl apply -f x.yaml', 'git push', 'npm test && git push', 'git commit -m x',
    'npm run migrate', 'cat a > b', 'npm test & bash deploy/hq.sh', 'sleep 1 & git push --force', 'ls &>/dev/null & rm -rf dist',
    'rg --pre ./x foo', 'git fetch --upload-pack=./x', 'git diff --output=x', 'git diff --output x', "rg '--pre' ./x foo", "git diff '--output=x'", 'git diff \\--output=x',
    'git fetch --upload-p=./x', 'git diff --ou=x', "rg $'--pre' ./p.sh x", 'rg {--pre,./p.sh} x', 'git diff {--output=o,HEAD}',
    'rg${IFS}--pre${IFS}./p.sh x', 'rg --p${X}re ./p.sh x', 'cat <<EOF\nx\nEOF', 'ls $(rm -rf x)', 'echo `id`', 'rm -rf dist', 'npm ci', '', 'gh pr merge 1']) {
    assert.equal(safeBash(c), false, c);
  }
  assert.equal(safeToInterrupt({ name: 'Read', input: { file_path: '/x' } }), true);
  assert.equal(safeToInterrupt({ name: 'WebSearch', input: {} }), true);
  for (const name of ['Edit', 'Write', 'Agent', 'mcp__company__tell', 'SomeNewTool']) assert.equal(safeToInterrupt({ name, input: {} }), false, name);
  assert.equal(safeToInterrupt({ name: 'Bash', input: {} }), false);
});

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '../../adapter/test/fixtures/fake-claude.mjs');
chmodSync(FAKE, 0o755);

async function hostWithClient() {
  const root = mkdtempSync(join(tmpdir(), 'sh-safe-'));
  const cwd = join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const host = new ShiftHost({ spec: { identity: 'tester', shift: 'tester-1', sessionId: 'S-safe', resume: false, cwd, settingsFile: '', stateRoot: root, claudeBin: FAKE },
    lingerMs: 60_000, onExit: () => {} });
  await host.start();
  const frames: Array<HostToHq & { at: number }> = [];
  const sock = createConnection(host.socketPath);
  const sp = new LineSplitter((l) => { const f = decodeHostFrame(l); if (f) frames.push({ ...f, at: Date.now() }); });
  sock.on('data', (d) => sp.push(d));
  const send = (f: HqToHost) => sock.write(encodeFrame(f));
  const wait = async (pred: (f: HostToHq) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit as any;
      if (Date.now() > end) throw new Error('timeout; got ' + JSON.stringify(frames.map((x) => x.t === 'event' ? x.ev.kind : x.t)));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  send({ t: 'hello', v: 1, client: 'hq', logId: null, since: 0 });
  await wait((f) => f.t === 'live');
  const close = async () => { send({ t: 'stop', id: 'stop', reason: 'test', graceMs: 500 }); await wait((f) => f.t === 'lifecycle' && f.state === 'exited'); sock.end(); };
  return { frames, send, wait, close };
}

const tool = (name: string, input: unknown, ms: number) => `TOOL ${JSON.stringify({ name, input, ms })}`;

test('his `now` during a safe tool stops it and is read within a second', async () => {
  const h = await hostWithClient();
  try {
    h.send({ t: 'send', id: 'a', msgId: 'work', text: tool('Bash', { command: 'npm test 2>&1 | tail -5' }, 5000), priority: 'next' });
    await h.wait((f) => f.t === 'event' && f.ev.kind === 'tool_use');
    const t0 = Date.now();
    h.send({ t: 'send', id: 'b', msgId: 'his', text: 'תעצרי', priority: 'now', stopIfSafe: true });
    const r = await h.wait((f) => f.t === 'reply' && f.re === 'b');
    assert.equal(r.ok, true);
    assert.equal(r.data.waitingOn, undefined);
    const started = await h.wait((f) => f.t === 'delivery' && f.msgId === 'his' && f.state === 'started');
    assert.ok(started.at - t0 < 1000, `read after ${started.at - t0}ms`);
    assert.ok(h.frames.some((f) => f.t === 'event' && f.ev.kind === 'result' && f.ev.isError), 'the tool turn was cut');
  } finally { await h.close(); }
});

test('his `now` during an unsafe tool waits for that tool only, goes in before the next step, and says what it waits for', async () => {
  const h = await hostWithClient();
  try {
    h.send({ t: 'send', id: 'a', msgId: 'work', text: tool('Bash', { command: 'bash deploy/hq.sh' }, 600), priority: 'next' });
    await h.wait((f) => f.t === 'event' && f.ev.kind === 'tool_use');
    h.send({ t: 'send', id: 'b', msgId: 'his', text: 'תעצרי', priority: 'now', stopIfSafe: true });
    const r = await h.wait((f) => f.t === 'reply' && f.re === 'b');
    assert.equal(r.data.waitingOn.tool, 'Bash');
    assert.equal(r.data.waitingOn.command, 'bash deploy/hq.sh');
    assert.ok(Date.parse(r.data.waitingOn.since) <= Date.now());
    const started = await h.wait((f) => f.t === 'delivery' && f.msgId === 'his' && f.state === 'started');
    const toolDone = h.frames.find((f) => f.t === 'event' && f.ev.kind === 'tool_result')!;
    assert.ok(toolDone.at <= started.at, 'after the tool');
    assert.ok(!h.frames.some((f) => f.t === 'event' && f.ev.kind === 'result' && f.ev.isError), 'nothing was cut');
    // Before the next step: the tool's turn ended right after the tool, with no further text of its own.
    assert.ok(!h.frames.some((f) => f.t === 'event' && f.ev.kind === 'text' && /ECHO:TOOL/.test((f.ev as any).text ?? '')));
    // No tool running (the model is answering): his second message does not cut the answer to his first.
    h.send({ t: 'send', id: 'e', msgId: 'first', text: 'שאלה ראשונה', priority: 'now', stopIfSafe: true });
    await h.wait((f) => f.t === 'delivery' && f.msgId === 'first' && f.state === 'started');
    h.send({ t: 'send', id: 'f', msgId: 'second', text: 'ועוד משהו', priority: 'now', stopIfSafe: true });
    await h.wait((f) => f.t === 'delivery' && f.msgId === 'second' && f.state === 'started');
    assert.ok(h.frames.some((f) => f.t === 'delivery' && f.msgId === 'first' && f.state === 'completed'), 'the first answer was not cut');
    // An unsafe tool is never interrupted, and a `now` without stopIfSafe (hq's own notes) never asks.
    h.send({ t: 'send', id: 'c', msgId: 'work2', text: tool('Read', { file_path: '/x' }, 600), priority: 'next' });
    await h.wait((f) => f.t === 'event' && f.ev.kind === 'tool_use' && (f.ev as any).name === 'Read');
    h.send({ t: 'send', id: 'd', msgId: 'note', text: 'תזכורת', priority: 'now' });
    const rd = await h.wait((f) => f.t === 'reply' && f.re === 'd');
    assert.equal(rd.data.waitingOn, undefined);
    await h.wait((f) => f.t === 'delivery' && f.msgId === 'note' && f.state === 'started');
    assert.ok(!h.frames.some((f) => f.t === 'event' && f.ev.kind === 'result' && f.ev.isError), 'hq notes do not cut');
  } finally { await h.close(); }
});
