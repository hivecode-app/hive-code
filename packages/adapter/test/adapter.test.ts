import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  uuidv5, shiftSessionId, normalize, buildArgs, buildSettings, buildEnv, ClaudeProcess,
  readTranscriptFile, findTranscript, projectSlug, envelope, injectForeign, toUsageReply,
  buildMcpConfig, ownerMcpServers,
} from '../src/index.ts';
import { createServer } from 'node:net';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.mjs');
chmodSync(FAKE, 0o755);

test('uuidv5 matches RFC 4122 reference vector', () => {
  // DNS namespace, "www.example.com" -> 2ed6657d-e927-568b-95e1-2665a8aea6a2
  assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.equal(shiftSessionId('yoav', 3), shiftSessionId('yoav', 3));
  assert.notEqual(shiftSessionId('yoav', 3), shiftSessionId('yoav', 4));
  assert.match(shiftSessionId('dana', 1), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('buildArgs/buildSettings follow B.5', () => {
  const spec = { identity: 'yoav', shift: 'yoav-1', sessionId: 'S', resume: false, cwd: '/w', settingsFile: '/s.json',
    stateRoot: '/st', mcpConfigFile: '/m.json', model: 'opus' };
  const a = buildArgs(spec);
  for (const f of ['--replay-user-messages', '--include-partial-messages', '--strict-mcp-config']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(a.indexOf('--session-id'), a.indexOf('--session-id') + 2), ['--session-id', 'S']);
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project,local');
  assert.equal(a[a.indexOf('--disallowedTools') + 1], 'AskUserQuestion');
  assert.ok(buildArgs({ ...spec, resume: true }).includes('--resume'));
  const s = buildSettings({ hookCommand: 'node /h/cli.ts hook', permissionRequestCommands: ['node /pa.mjs'] }) as any;
  assert.equal(s.crossSessionInbound, 'accept');
  assert.equal(s.autoMemoryEnabled, false);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'node /h/cli.ts hook SessionStart');
  assert.equal(s.hooks.PostToolUse[0].matcher, 'SendMessage|Bash');
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Write|Edit|NotebookEdit|Bash');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node /h/cli.ts hook PreToolUse');
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].command, 'node /pa.mjs');
  for (const ev of Object.keys(s.hooks)) for (const h of s.hooks[ev]) for (const x of h.hooks) assert.equal(x.type, 'command');
  assert.throws(() => buildSettings({ hookCommand: 'x', extra: { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://hq' }] }] } } }), /only command/);
  assert.deepEqual(s.claudeMdExcludes.length, 1);
});

test('buildEnv strips parent session identity and sets COMPANY_*', () => {
  const env = buildEnv({ identity: 'a', shift: 'a-1', sessionId: 'S', resume: false, cwd: '/', settingsFile: '', stateRoot: '/st', oauthToken: 'tok' },
    { PATH: '/bin', CLAUDE_CODE_MESSAGING_TOKEN: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'p' });
  assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  assert.equal(env.COMPANY_SHIFT, 'a-1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
});

test('normalize: wire shapes observed on 2.1.303', () => {
  assert.deepEqual(normalize({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', isReplay: true }).events,
    [{ kind: 'user_echo', uuid: 'u1', text: 'hi' }]);
  assert.deepEqual(normalize({ type: 'command_lifecycle', command_uuid: 'u1', state: 'queued' }).lifecycle,
    { commandUuid: 'u1', state: 'queued' });
  const rl = normalize({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1,
    unifiedWindows: { five_hour: { utilization: 0.17 }, seven_day: { utilization: 0.5 } } } }).events[0];
  assert.deepEqual(rl, { kind: 'rate_limit', status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1, fiveHour: 0.17, sevenDay: 0.5 });
  const d = normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } });
  assert.deepEqual(d.events, [{ kind: 'text_delta', text: 'O' }]);
  // Deltas get the id of their message (from message_start), so the final `text` replaces that bubble.
  const st = {};
  normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_b' } } }, st);
  assert.deepEqual(normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'היי' } } }, st).events,
    [{ kind: 'text_delta', text: 'היי', messageId: 'msg_b' }]);
  assert.deepEqual(normalize({ type: 'stream_event', parent_tool_use_id: 't9', event: { type: 'message_start', message: { id: 'msg_sub' } } }, st).events, []);
  assert.deepEqual(normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } } }, st).events,
    [{ kind: 'text_delta', text: '!', messageId: 'msg_b' }], 'a subagent message_start does not take over');
  assert.deepEqual(normalize({ type: 'assistant', parent_tool_use_id: 't9', message: { id: 'msg_sub', content: [{ type: 'text', text: 'דוח' }] } }).events,
    [{ kind: 'text', text: 'דוח', messageId: 'msg_sub', parentToolUseId: 't9' }], 'a subagent\'s text says whose it is');
  assert.deepEqual(normalize({ type: 'assistant', message: { id: 'msg_top', content: [{ type: 'text', text: 'שלי' }] } }).events,
    [{ kind: 'text', text: 'שלי', messageId: 'msg_top' }]);
  const tr = normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  assert.deepEqual(tr.events, [{ kind: 'tool_result', toolUseId: 't1', isError: false, preview: 'ok' }]);
  const cr = normalize({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { a: 1 } } });
  assert.deepEqual(cr.control, { requestId: 'r', ok: true, response: { a: 1 }, error: undefined });
  assert.equal(normalize({ type: 'brand_new_thing' }).events[0]!.kind, 'other');
  const res = normalize({ type: 'result', subtype: 'success', is_error: false, result: 'OK', modelUsage: { m: { contextWindow: 1000000 } } }).events[0] as any;
  assert.equal(res.contextWindow, 1000000);
  assert.equal(toUsageReply({ rate_limits: { five_hour: { utilization: 18 }, seven_day: { utilization: 50 } } }).sevenDay, 50);
});

test('transcript reader is tolerant: bad lines, unknown types, compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  const proj = join(dir, 'projects', projectSlug('/home/x/repo'));
  mkdirSync(proj, { recursive: true });
  const p = join(proj, 'sess-1.jsonl');
  writeFileSync(p, [
    JSON.stringify({ type: 'user', uuid: 'a', parentUuid: null, message: { role: 'user', content: 'hello' }, timestamp: 't1' }),
    '{"type":"assistant", BROKEN',
    JSON.stringify({ type: 'assistant', uuid: 'b', parentUuid: 'a', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/repo/CLAUDE.md' }] } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c', parentUuid: null, compactMetadata: { trigger: 'manual', preTokens: 9 } }),
    JSON.stringify({ type: 'user', uuid: 'd', parentUuid: 'c', isCompactSummary: true, message: { content: 'summary' } }),
    JSON.stringify({ type: 'hologram-sync', x: 1 }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'd' }),
    '',
    '42',
  ].join('\n'));
  assert.equal(projectSlug('/tmp/cc-lab-1'), '-tmp-cc-lab-1');
  assert.equal(findTranscript('sess-1', { cwd: '/home/x/repo', projects: join(dir, 'projects') }), p);
  assert.equal(findTranscript('sess-1', { projects: join(dir, 'projects') }), p);
  const a = await readTranscriptFile(p, 'sess-1');
  assert.equal(a.badLines, 2);
  assert.deepEqual(a.unknownTypes, ['hologram-sync']);
  assert.equal(a.messages.length, 3);
  assert.deepEqual(a.messages[1]!.toolUses, ['Bash']);
  assert.equal(a.messages[2]!.isCompactSummary, true);
  assert.equal(a.compactBoundaries[0]!.preTokens, 9);
  assert.equal(a.leafUuid, 'd');
  assert.deepEqual(a.instructionFiles, ['/repo/CLAUDE.md']);
  assert.equal(a.typeCounts['system/compact_boundary'], 1);
});

test('ClaudeProcess over a fake CLI: echo, lifecycle, control, stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));
  const life: string[] = [];
  const kinds: string[] = [];
  const p = new ClaudeProcess({ identity: 't', shift: 't-1', sessionId: 'S1', resume: false, cwd: dir, settingsFile: '',
    stateRoot: dir, claudeBin: FAKE }, {
    onLifecycle: (l) => life.push(l.state),
    onEvent: (e) => kinds.push(e.kind),
  });
  const uuid = p.sendUser('ping');
  const ctx = await p.contextUsage();
  assert.equal(ctx.totalTokens, 1234);
  let resultText = '';
  for await (const ev of p.events()) { if (ev.kind === 'result') { resultText = ev.text ?? ''; break; } }
  assert.equal(resultText, 'ECHO:ping');
  assert.ok(kinds.includes('user_echo') && kinds.includes('text_delta') && kinds.includes('init'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(life, ['queued', 'started', 'completed']);
  assert.ok(uuid);
  await p.stop(2000);
  assert.equal(p.exited, true);
  await assert.rejects(p.usage(), /stdin closed|exited/);
});

test('injectForeign writes auth-less envelope line to the socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-'));
  const sockPath = join(dir, 's.sock');
  let got = '';
  const srv = createServer((s) => { s.on('data', (d) => { got += d; }); });
  await new Promise<void>((r) => srv.listen(sockPath, r));
  await injectForeign(1, 'BODY', { socketPath: sockPath, fromName: 'yoav' });
  await new Promise((r) => setTimeout(r, 50));
  srv.close();
  const line = JSON.parse(got.trim());
  assert.equal(line.type, 'user');
  assert.equal(line.message.content, envelope('BODY', 'yoav'));
  assert.match(line.message.content, /from-mode="bypass"/);
});

test('every shift gets the owner\'s global MCP servers (browser), and company stays ours', () => {
  const d = mkdtempSync(join(tmpdir(), 'mcp-'));
  const f = join(d, '.claude.json');
  const browser = { type: 'stdio', command: 'node', args: ['/b/gateway.ts'], env: { X: '1' } };
  writeFileSync(f, JSON.stringify({ projects: {}, mcpServers: { browser, company: { command: 'evil' } } }));
  const others = ownerMcpServers(f);
  assert.deepEqual(others, { browser });
  const cfg = buildMcpConfig(['/usr/bin/node', '/srv.ts'], others) as { mcpServers: Record<string, any> };
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['browser', 'company']);
  assert.deepEqual(cfg.mcpServers.company, { type: 'stdio', command: '/usr/bin/node', args: ['/srv.ts'] });
  // A missing or broken ~/.claude.json never blocks a shift: it just starts with company only.
  const warned: string[] = [];
  const warn = (m: string) => { warned.push(m); };
  assert.deepEqual(ownerMcpServers(join(d, 'nope.json'), warn), {});
  writeFileSync(f, '{not json');
  assert.deepEqual(ownerMcpServers(f, warn), {});
  writeFileSync(f, JSON.stringify({ mcpServers: [] }));
  assert.deepEqual(ownerMcpServers(f, warn), {});
  assert.equal(warned.length, 3);
  assert.ok(warned.every((m) => m.includes('without the owner')), warned.join('\n'));
  // No mcpServers at all is not an error: nothing to warn about.
  writeFileSync(f, JSON.stringify({ projects: {} }));
  assert.deepEqual(ownerMcpServers(f, warn), {});
  assert.equal(warned.length, 3);
  // The shift still gets company alone.
  assert.deepEqual(Object.keys((buildMcpConfig(['/n', '/s'], ownerMcpServers(f)) as any).mcpServers), ['company']);
});
