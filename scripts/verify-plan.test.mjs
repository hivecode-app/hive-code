import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from './verify-plan.mjs';

const APKSIGNER = '/opt/android-sdk/build-tools/36.0.0/apksigner';
const groups = ['configInGit', 'dictation', 'webApp', 'apk', 'apkSignature', 'tab'];
const fsOf = (paths) => (p) => paths.includes(p);

test('hq-host: every group runs', () => {
  const fromFile = { auth: { appUrl: 'https://app.hq.example.com/' }, dictate: { url: 'http://127.0.0.1:8790' },
    telegramChat: '1', tab: { baseUrl: 'https://tab.hq.example.com' } };
  const plan = verifyPlan({
    fromFile, cfg: { ...fromFile, appReleaseDir: '/var/www/hq-app/current' }, companyHome: '/c', engine: '/e',
    apksigner: APKSIGNER,
    exists: fsOf(['/c/company/hq.config.json', '/var/www/hq-app/current/app-release.json', '/var/www/hq-app/current/main.dart.js', APKSIGNER]),
  });
  for (const g of groups) assert.equal(plan[g].run, true, g);
});

test('a generic install from the code (install.sh): only what every install has, the rest is a skip with a reason', () => {
  const fromFile = { companyHome: '/c', apiUrl: 'https://hq.example.com/hq', appReleaseDir: null, auth: { appUrl: 'https://hq.example.com' } };
  const plan = verifyPlan({
    fromFile, cfg: { ...fromFile, dictate: { url: null }, tab: { baseUrl: 'http://127.0.0.1:7422' } }, companyHome: '/c', engine: '/e',
    apksigner: APKSIGNER, exists: fsOf(['/e/web/index.html']),
  });
  for (const g of groups) {
    assert.equal(plan[g].run, false, g);
    assert.ok(plan[g].why, g);
  }
});

test('a generic install from a release (web/ and apk/ in the engine): the app and APK run, the signature waits for apksigner', () => {
  const fromFile = { appReleaseDir: '/e/apk', auth: { appUrl: 'https://hq.example.com' } };
  const run = (paths) => verifyPlan({
    fromFile, cfg: { ...fromFile, dictate: { url: null } }, companyHome: '/c', engine: '/e',
    apksigner: APKSIGNER, exists: fsOf(['/e/web/main.dart.js', '/e/apk/app-release.json', ...paths]),
  });
  const plan = run([]);
  assert.equal(plan.webApp.run, true);
  assert.equal(plan.apk.run, true);
  assert.equal(plan.apkSignature.run, false);
  assert.match(plan.apkSignature.why, /apksigner/);
  assert.equal(run([APKSIGNER]).apkSignature.run, true);
});

test('dictation and tab.hq follow their settings; VERIFY_TAB_URL forces tab.hq', () => {
  const base = { companyHome: '/c', engine: '/e', apksigner: APKSIGNER, exists: () => false };
  assert.equal(verifyPlan({ ...base, fromFile: {}, cfg: { dictate: { url: 'http://127.0.0.1:8790' } } }).dictation.run, true);
  assert.equal(verifyPlan({ ...base, fromFile: { tab: { baseUrl: 'https://tab.example.com' } }, cfg: {} }).tab.run, true);
  assert.equal(verifyPlan({ ...base, fromFile: null, cfg: {}, env: { VERIFY_TAB_URL: 'http://x' } }).tab.run, true);
  assert.equal(verifyPlan({ ...base, fromFile: null, cfg: {} }).tab.run, false);
});
