// The generic product, step 1 (docs/generic/PLAN.md): one company's values live in its hq.config.json and
// org.yaml, not in code. With hq-host's file hq gets exactly what it had before; with none, nothing of anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APK_ORIGIN, loadConfig } from '../src/config.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');

function withHome<T>(home: string, f: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return f(); } finally { process.env.HOME = prev; }
}

test("hq-host: company/hq.config.json + company/org.yaml give exactly the values hq had in code before", () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-config-'));
  try {
    copyFileSync(join(REPO, 'company', 'hq.config.json'), join(dir, 'hq.config.json'));
    const cfg = withHome('/home/owner', () => loadConfig({ stateDir: dir, companyDir: join(REPO, 'company') }));
    // The values that used to be the defaults in config.ts, auth.ts and push.ts (before the generic product).
    assert.deepEqual({
      managerId: cfg.managerId, monitoringLeadId: cfg.monitoringLeadId, telegramChat: cfg.telegramChat, telegramCmd: cfg.telegramCmd,
      defaultCwd: cfg.defaultCwd, residents: cfg.capacity.residents, auth: cfg.auth, dictateUrl: cfg.dictate.url,
      accounts: cfg.accounts, tab: cfg.tab, appReleaseDir: cfg.appReleaseDir, pushContact: cfg.pushContact,
    }, {
      managerId: 'yoav', monitoringLeadId: 'rotem', telegramChat: '100000001', telegramCmd: '/home/owner/bin/telegram-send',
      defaultCwd: '/home/owner/projects/agent-company', residents: ['yoav'],
      auth: {
        rpId: 'app.hq.example.com', rpName: 'החברה',
        origins: ['https://app.hq.example.com', 'android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
        appUrl: 'https://app.hq.example.com/', pairCodeMs: 10 * 60_000, userName: 'ran', userDisplayName: 'רן',
      },
      dictateUrl: 'http://127.0.0.1:8790',
      accounts: [
        { name: 'owner-account', label: 'החשבון הראשי', expect: 'owner-account@example.com', managed: false },
        { name: 'hive-owner', label: 'hive-owner', expect: 'hive-owner', managed: true },
      ],
      tab: { listen: '127.0.0.1:7422', baseUrl: 'https://tab.hq.example.com', cdpUrl: 'http://127.0.0.1:9222', ttlMin: 10 },
      appReleaseDir: '/var/www/hq-app/current', pushContact: 'mailto:owner-account@example.com',
    });
    assert.equal(cfg.apiUrl, 'https://api.hq.example.com');
    assert.equal(cfg.memoryImport.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no hq.config.json and no org.yaml: generic values, nothing of one particular company', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-config-'));
  try {
    const cfg = withHome('/home/someone', () => loadConfig({ stateDir: join(dir, 'state'), companyDir: join(dir, 'company') }));
    assert.equal(cfg.managerId, 'manager');
    assert.equal(cfg.monitoringLeadId, 'manager', 'anomalies go to the manager when there is no monitoring lead');
    assert.deepEqual(cfg.capacity.residents, ['manager']);
    assert.equal(cfg.telegramChat, '');
    assert.equal(cfg.defaultCwd, '/home/someone');
    assert.deepEqual(cfg.auth.origins, [APK_ORIGIN], 'the APK is the engine\'s, accepted everywhere');
    assert.equal(cfg.auth.appUrl, null);
    assert.equal(cfg.apiUrl, null);
    assert.equal(cfg.dictate.url, null);
    assert.deepEqual(cfg.accounts, [{ name: 'claude', label: 'Claude', expect: '', managed: false }]);
    assert.deepEqual(cfg.memoryImport, []);
    // shiftTemplate is a path inside the engine's own checkout, wherever that is installed.
    const all = JSON.stringify({ ...cfg, shiftTemplate: undefined }).toLowerCase();
    for (const s of ['ran', 'רן', 'hivecode', 'yoav', 'rotem', '100000001', 'owner-account', '8790']) {
      assert.ok(!all.includes(s), `"${s}" in the generic config`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('org.yaml gives manager, monitoring lead and residents; hq.config.json still wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-config-'));
  try {
    mkdirSync(join(dir, 'company'));
    writeFileSync(join(dir, 'company', 'org.yaml'), [
      'version: 1', 'owner: dana', 'manager: noa', 'monitoring_lead: tal', 'timezone: Europe/Berlin',
      'identities:', '  - {id: noa, resident: true}', '  - {id: tal}', '',
    ].join('\n'));
    const fromOrg = loadConfig({ stateDir: join(dir, 'state'), companyDir: join(dir, 'company') });
    assert.deepEqual([fromOrg.managerId, fromOrg.monitoringLeadId, fromOrg.capacity.residents], ['noa', 'tal', ['noa']]);
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state', 'hq.config.json'), JSON.stringify({ managerId: 'dana', auth: { origins: ['https://x.example'] } }));
    const both = loadConfig({ stateDir: join(dir, 'state'), companyDir: join(dir, 'company') });
    assert.equal(both.managerId, 'dana');
    assert.deepEqual(both.auth.origins, ['https://x.example', APK_ORIGIN]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
