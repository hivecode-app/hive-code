import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redact, knownSecrets, buildReport } from './company-doctor.mjs';

test('redact: tokens, keys and auth headers go; shas, digests, paths and ordinary words stay', () => {
  const sha = '34ba877c0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const digest = 'a'.repeat(64);
  const text = [
    'Authorization: Bearer abc.def-ghi_jklmnopqrstu',
    'DICTATE_TOKEN=s3cr3t-value',
    'export GH_TOKEN="ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"',
    '{"privateKey":"MIGHAgEAMBMGByqGSM49","subject":"x"}',
    'GET /pair?code=482913&x=1',
    'key sk-ant-' + 'oat01-AbCdEf_123',
    'opaque Zx9QpL2mN8vR4tY6uI0oP3aS5dF7gH1jK',
    `commit ${sha} sha256 ${digest}`,
    'path /home/u/.local/state/agent-company/hq.db, ActiveState=active',
    'usage input_tokens: 1200 output_tokens=33',
    'access_token=at-123 client_secret: cs-456 db_password=pw789x refresh_token: "rt-0" sessionToken=st-1',
    'std b64 Ab3dEf/Gh1+Jk2LmN3oP4qR5sT6uV7wX8yZ9aB0c and Ab3dEfGh1Jk2LmN3oP4qR5sT6/uV7wX8yZ9aB0cDe==',
    'at /home/Dana1/projects/agent-company/packages/hq/src/VeryLongModuleName2WithDigits3AndCaps.ts:431',
  ].join('\n');
  const out = redact(text);
  for (const s of ['at-123', 'cs-456', 'pw789x', 'rt-0', 'st-1', 'Ab3dEf/Gh1+', 'Ab3dEfGh1Jk2', 'abc.def-ghi', 's3cr3t-value', 'ghp_ABC', 'MIGHAgEA', '482913', 'sk-ant-', 'Zx9QpL2']) assert.ok(!out.includes(s), s);
  for (const s of [sha, digest, '/home/u/.local/state/agent-company/hq.db', 'ActiveState=active', '"subject":"x"', 'DICTATE_TOKEN=', 'input_tokens: 1200', 'output_tokens=33', 'VeryLongModuleName2WithDigits3AndCaps.ts:431']) assert.ok(out.includes(s), s);
});

test('redact: the secrets of this install by value, wherever they show up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  try {
    const state = join(dir, 'state'); const cfg = join(dir, 'cfg');
    mkdirSync(state); mkdirSync(cfg);
    writeFileSync(join(state, 'api-token'), 'deadbeefdeadbeef01\n');
    writeFileSync(join(cfg, 'hq.env'), '# x\nDICTATE_TOKEN=cafe0123cafe0123\n');
    writeFileSync(join(state, 'vapid.json'), JSON.stringify({ publicKey: 'pubpubpubpub', privateKey: 'privprivpriv' }));
    const known = knownSecrets(state, cfg);
    const out = redact('hq said deadbeefdeadbeef01 and cafe0123cafe0123 / privprivpriv', known);
    assert.equal(out, 'hq said [הוסתר] and [הוסתר] / [הוסתר]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the report: every section, from what the commands say; no transcript is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  try {
    const state = join(dir, 'state');
    mkdirSync(join(state, 'shifts'), { recursive: true });
    writeFileSync(join(state, 'shifts', 'yoav-3.ndjson'), 'TRANSCRIPT-CONTENT\n');
    writeFileSync(join(state, 'hq.config.json'), JSON.stringify({ apiUrl: 'https://api.example.test/', auth: { appUrl: 'https://app.example.test' } }));
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'systemctl' && args.includes('--state=active')) return 'company-shift@yoav-3.service loaded active running x';
      if (cmd === 'journalctl') return `log of ${args[2]} token=abcdef123456`;
      if (cmd === 'node' && String(args[0]).endsWith('verify-prod.mjs')) return '✓ api\n✗ app';
      return `(${cmd})`;
    };
    const r = redact(buildReport({ run, state, configDir: join(dir, 'cfg'), data: join(dir, 'data'), home: dir, now: new Date(0) }));
    for (const h of ['גרסאות', 'החברה', 'יחידות', 'כתובת ציבורית', 'אימות מקצה לקצה', 'משאבים', 'לוג hq', 'לוגים של המשמרות']) assert.match(r, new RegExp(`## ${h}`));
    assert.match(r, /log of company-shift@yoav-3\.service/);
    assert.match(r, /https:\/\/api\.example\.test\/health/);
    assert.match(r, /✗ app/);
    assert.ok(!r.includes('TRANSCRIPT-CONTENT'));
    assert.ok(!r.includes('abcdef123456'));
    assert.ok(calls.some((c) => c.startsWith('journalctl --user -u agent-company-hq')));
    const noVerify = buildReport({ run, state, configDir: dir, data: dir, home: dir, verify: false });
    assert.match(noVerify, /דולג/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
