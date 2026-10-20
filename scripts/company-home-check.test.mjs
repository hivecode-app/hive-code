import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { companyHomeFindings, liveReaders, readerHome } from './company-home-check.mjs';

const ENGINE = '/home/u/projects/agent-company';
const HOME = '/home/u/company';
const fails = (fs) => fs.filter((f) => !f.ok).map((f) => f.line);

test('before the split: the engine repo is the company, and every reader agrees', () => {
  const f = companyHomeFindings({ home: ENGINE, engineRoot: ENGINE, hqHome: ENGINE, readers: [{ shift: 'yoav-3', home: ENGINE }] });
  assert.deepEqual(fails(f), []);
  assert.match(f[0].line, /לא מוגדר/);
});

test('after the split: hq and every live worker read from COMPANY_HOME, or verify-prod fails and names who does not', () => {
  const exists = () => true;
  const good = companyHomeFindings({ home: HOME, engineRoot: ENGINE, hqHome: HOME, exists,
    readers: [{ shift: 'yoav-3', home: HOME }, { shift: 'eli-2', home: HOME }] });
  assert.deepEqual(fails(good), []);
  const bad = companyHomeFindings({ home: HOME, engineRoot: ENGINE, hqHome: ENGINE, exists,
    readers: [{ shift: 'yoav-3', home: HOME }, { shift: 'eli-2', home: ENGINE }] });
  assert.equal(fails(bad).length, 2);
  assert.match(fails(bad)[0], /hq קורא את החברה מ-\/home\/u\/projects\/agent-company/);
  assert.match(fails(bad)[1], /eli-2/);
  assert.doesNotMatch(fails(bad)[1], /yoav-3/);
  const missing = companyHomeFindings({ home: HOME, engineRoot: ENGINE, hqHome: HOME, readers: [], exists: (p) => p.endsWith('org.yaml') });
  assert.match(fails(missing)[0], /חסרים: memory/);
  const inside = companyHomeFindings({ home: `${ENGINE}/company-home`, engineRoot: ENGINE, hqHome: `${ENGINE}/company-home`, readers: [], exists });
  assert.match(fails(inside)[0], /בתוך repo המנוע/);
});

test('a worker reads memory from COMPANY_HOME, else COMPANY_REPO, else its cwd (mcp-company server.ts)', () => {
  assert.equal(readerHome({ COMPANY_HOME: '/h', COMPANY_REPO: '/r' }, '/c'), '/h');
  assert.equal(readerHome({ COMPANY_REPO: '/r' }, '/c'), '/r');
  assert.equal(readerHome({}, '/c'), '/c');
  assert.equal(readerHome({}, null), null);
});

test('liveReaders: a shift in an install test container on the same host (another mount namespace) is not counted', () => {
  const proc = mkdtempSync(join(tmpdir(), 'proc-'));
  const server = `node packages${sep}mcp-company${sep}src${sep}server.ts`;
  const pid = (n, ns, env, cmd = server) => {
    mkdirSync(join(proc, n, 'ns'), { recursive: true });
    writeFileSync(join(proc, n, 'cmdline'), cmd.replaceAll(' ', '\0'));
    writeFileSync(join(proc, n, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0'));
    symlinkSync(ns, join(proc, n, 'ns', 'mnt'));
    symlinkSync('/somewhere', join(proc, n, 'cwd'));
  };
  try {
    mkdirSync(join(proc, 'self', 'ns'), { recursive: true });
    symlinkSync('mnt:[1]', join(proc, 'self', 'ns', 'mnt'));
    pid('10', 'mnt:[1]', { COMPANY_SHIFT: 'adi-1', COMPANY_HOME: '/home/owner/company' });
    pid('11', 'mnt:[2]', { COMPANY_SHIFT: 'manager-1', COMPANY_HOME: '/home/tester/company' });
    pid('12', 'mnt:[1]', { COMPANY_SHIFT: 'x-1' }, 'node something-else.js');
    pid('13', 'mnt:[1]', { PATH: '/bin' });
    assert.deepEqual(liveReaders(proc), [{ shift: 'adi-1', home: '/home/owner/company' }]);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});

test('liveReaders on the real /proc: no throw, and every reader has a shift', () => {
  for (const r of liveReaders()) assert.ok(r.shift);
});
