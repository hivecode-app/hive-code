// One app for every server (pairing.ts): the pairing page and assetlinks.json, served by hq itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { APP_PACKAGE, assetLinks, certFingerprint, pairLink } from '../src/pairing.ts';

// bytes 0..31 as the cert's sha256.
const APK = 'android:apk-key-hash:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PRINT = [...Array(32).keys()].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

test('pairing: assetlinks.json from the APK origin', () => {
  assert.deepEqual(assetLinks(['https://app.example.com', APK]), [{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: APP_PACKAGE, sha256_cert_fingerprints: [PRINT] },
  }]);
  assert.equal(certFingerprint('https://x'), null);
  assert.deepEqual(assetLinks(['https://app.example.com']), []);
});

test('pairing: the link lives at the root of the app origin, whatever path the app has', () => {
  assert.equal(pairLink('https://app.hq.example.com/', 'ABCD-EFGH'), 'https://app.hq.example.com/pair?code=ABCD-EFGH');
  assert.equal(pairLink('https://box.tail1.ts.net/p/', 'ABCD-EFGH'), 'https://box.tail1.ts.net/pair?code=ABCD-EFGH');
  assert.equal(pairLink(null, 'ABCD-EFGH'), null);
});

test('pairing: hq serves /pair and assetlinks.json without a token', async () => {
  const env = await makeEnv({ noStart: true, cfg: { auth: { rpId: 'box.tail1.ts.net', rpName: 'החברה', origins: ['https://box.tail1.ts.net', APK], appUrl: null, pairCodeMs: 600_000, userName: 'owner', userDisplayName: 'owner' } } });
  await env.hq.start({ listen: true, timers: false });
  try {
    const base = `http://127.0.0.1:${env.hq.port}`;
    const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

    const al = await get('/.well-known/assetlinks.json');
    assert.equal(al.status, 200);
    assert.match(al.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await al.json(), assetLinks([APK]));

    // No appUrl: the origin is what Caddy forwarded. Android gets "open in the app" with the whole link.
    const android = 'Mozilla/5.0 (Linux; Android 15; CPH2653) Chrome/130 Mobile';
    const r = await get('/pair?code=abcd-efgh', { 'x-forwarded-host': 'box.tail1.ts.net', 'x-forwarded-proto': 'https', 'user-agent': android });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /ABCD-EFGH/);
    assert.match(html, /box\.tail1\.ts\.net/);
    const link = encodeURIComponent('https://box.tail1.ts.net/pair?code=ABCD-EFGH');
    assert.ok(html.includes(`intent://pair?url=${link}#Intent;scheme=agentcompany;package=${APP_PACKAGE};`), html);
    assert.ok(html.includes('href="https://box.tail1.ts.net/?pair=ABCD-EFGH"'), 'go on in the browser');
    // Hebrew, right to left, in the app's palette: a black primary button, not the old blue.
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.match(html, /--accent: #1B1C1E/);
    assert.ok(!html.includes('#1F6FEB'));

    // A desktop browser gets only the web app.
    const desk = await (await get('/pair?code=ABCD-EFGH', { 'x-forwarded-host': 'box.tail1.ts.net', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' })).text();
    assert.ok(!desk.includes('intent://'));

    // Looking at the page never spends the code, and garbage is a plain 400 page, never echoed.
    const bad = await get('/pair?code=%3Cscript%3E', { 'x-forwarded-host': 'box.tail1.ts.net' });
    assert.equal(bad.status, 400);
    assert.ok(!(await bad.text()).includes('<script>'));
    const evil = await get('/pair?code=ABCD-EFGH', { 'x-forwarded-host': '"><script>' });
    assert.equal(evil.status, 400);
  } finally { await env.cleanup(); }
});

test('pairing: with appUrl the page trusts it over the Host header', async () => {
  const env = await makeEnv({ noStart: true, cfg: { auth: { rpId: 'app.hq.example.com', rpName: 'החברה', origins: [APK], appUrl: 'https://app.hq.example.com/', pairCodeMs: 600_000, userName: 'owner', userDisplayName: 'owner' } } });
  await env.hq.start({ listen: true, timers: false });
  try {
    const html = await (await fetch(`http://127.0.0.1:${env.hq.port}/pair?code=ABCD-EFGH`, { headers: { 'x-forwarded-host': 'evil.example' } })).text();
    assert.ok(html.includes('href="https://app.hq.example.com/?pair=ABCD-EFGH"'));
    assert.ok(!html.includes('evil.example'));
  } finally { await env.cleanup(); }
});
