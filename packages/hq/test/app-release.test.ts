import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { AppReleases, RELEASE_FILE } from '../src/app-release.ts';

/** A release dir the way scripts/deploy.sh app writes it, and `current` pointing at it. */
function release(root: string, name: string, code: number, apk = Buffer.from(`apk ${name}`), meta: Record<string, unknown> = {}) {
  const dir = join(root, 'releases', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-company.apk'), apk);
  writeFileSync(join(dir, RELEASE_FILE), JSON.stringify({
    version_code: code, version_name: '0.1.0', sha: name, apk: 'agent-company.apk',
    sha256: createHash('sha256').update(apk).digest('hex'), bytes: apk.length, ...meta,
  }));
  // The same atomic swap deploy.sh does.
  symlinkSync(dir, join(root, '.current.new'));
  renameSync(join(root, '.current.new'), join(root, 'current'));
  return apk;
}

test('AppReleases: follows the current symlink, refuses a release it cannot vouch for', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-release-'));
  try {
    const r = new AppReleases(join(root, 'current'));
    assert.equal(r.latest(), null, 'no release yet');
    assert.equal(new AppReleases(null).latest(), null);

    const apk = release(root, 'a', 2085);
    const l = r.latest()!;
    assert.equal(l.release.version_code, 2085);
    assert.equal(l.release.bytes, apk.length);
    assert.equal(l.release.apk_path, '/api/app/apk/2085');
    assert.equal(readFileSync(l.file, 'utf8'), 'apk a');
    assert.equal(r.apk(2085)?.file, l.file);
    assert.equal(r.apk(2084), null, 'only the live version is served');

    release(root, 'b', 2090);
    assert.equal(r.latest()!.release.version_code, 2090, 'a deploy is picked up without a restart');
    assert.equal(r.apk(2085), null);

    release(root, 'c', 2091, Buffer.from('x'), { bytes: 999 });
    assert.equal(r.latest(), null, 'size does not match the APK');
    release(root, 'd', 2092, Buffer.from('x'), { sha256: 'nope' });
    assert.equal(r.latest(), null, 'bad sha256');
    release(root, 'e', 2093, Buffer.from('x'), { apk: '../hq.db' });
    assert.equal(r.latest(), null, 'apk must be a file in the release dir');
    release(root, 'f', 0);
    assert.equal(r.latest(), null, 'bad version_code');
    release(root, 'g', 2094);
    rmSync(join(root, 'releases', 'g', 'agent-company.apk'));
    assert.equal(r.latest(), null, 'APK missing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('API: /api/app/latest and the APK download, behind the token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-release-api-'));
  const env = await makeEnv({ noStart: true, cfg: { appReleaseDir: join(root, 'current') } });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const base = `http://127.0.0.1:${env.hq.port}`;
    const get = (path: string, auth = true) => fetch(base + path, { headers: auth ? { authorization: `Bearer ${token}` } : {} });

    assert.deepEqual(await (await get('/api/app/latest')).json(), { latest: null });
    const apk = release(root, 'a', 2085, Buffer.alloc(300_000, 7));
    assert.equal((await get('/api/app/latest', false)).status, 401);
    assert.equal((await get('/api/app/apk/2085', false)).status, 401);

    const { latest } = await (await get('/api/app/latest')).json() as { latest: Record<string, unknown> };
    assert.equal(latest.version_code, 2085);
    assert.equal(latest.sha256, createHash('sha256').update(apk).digest('hex'));
    const res = await get(latest.apk_path as string);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(Number(res.headers.get('content-length')), apk.length);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), apk);

    release(root, 'b', 2086);
    assert.equal((await get('/api/app/apk/2085')).status, 404, 'an older version is gone once a new one is live');
    assert.equal((await get('/api/app/apk/2086')).status, 200);
  } finally {
    await env.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
