// The generic product, step 1 (docs/generic/PLAN.md): one company's values live in its hq.config.json and
// org.yaml, not in code. With a company's file hq gets exactly its values; with none, nothing of anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyLocation, loadConfig, type HqConfig } from '../src/config.ts';
import { makeEnv, ORG_YAML } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'company-home');

function withHome<T>(home: string, f: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return f(); } finally { process.env.HOME = prev; }
}

test('a company\'s hq.config.json + org.yaml (the example company in fixtures/) give exactly its values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-config-'));
  try {
    copyFileSync(join(FIXTURE, 'company', 'hq.config.json'), join(dir, 'hq.config.json'));
    const cfg = withHome('/home/shira', () => loadConfig({ stateDir: dir, companyDir: join(FIXTURE, 'company') }));
    assert.deepEqual({
      managerId: cfg.managerId, monitoringLeadId: cfg.monitoringLeadId, telegramChat: cfg.telegramChat, telegramCmd: cfg.telegramCmd,
      defaultCwd: cfg.defaultCwd, residents: cfg.capacity.residents, auth: cfg.auth, dictateUrl: cfg.dictate.url,
      accounts: cfg.accounts, tab: cfg.tab, appReleaseDir: cfg.appReleaseDir, pushContact: cfg.pushContact,
    }, {
      managerId: 'gal', monitoringLeadId: 'hadar', telegramChat: '100200300', telegramCmd: '/home/shira/bin/telegram-send',
      defaultCwd: '/home/shira/projects/engine', residents: ['gal'],
      auth: {
        rpId: 'app.hq.example.com', rpName: 'החברה',
        origins: ['https://app.hq.example.com'],
        appUrl: 'https://app.hq.example.com/', pairCodeMs: 10 * 60_000, userName: 'shira', userDisplayName: 'שירה',
      },
      dictateUrl: 'http://127.0.0.1:8790',
      accounts: [
        { name: 'personal', label: 'האישי', expect: 'shira@example.com', managed: false },
        { name: 'work', label: 'העבודה', expect: 'shira-work', managed: true },
      ],
      tab: { listen: '127.0.0.1:7422', baseUrl: 'https://tab.hq.example.com', cdpUrl: 'http://127.0.0.1:9222', ttlMin: 10, passkeys: true },
      appReleaseDir: '/var/www/hq-app/current', pushContact: 'mailto:shira@example.com',
    });
    assert.equal(cfg.apiUrl, 'https://api.hq.example.com');
    assert.equal(cfg.memoryImport.length, 2);
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
    assert.deepEqual(cfg.auth.origins, [], 'no origin of one particular company or APK key');
    assert.equal(cfg.auth.appUrl, null);
    assert.equal(cfg.apiUrl, null);
    assert.equal(cfg.dictate.url, null);
    assert.deepEqual(cfg.accounts, [{ name: 'claude', label: 'Claude', expect: '', managed: false }]);
    assert.deepEqual(cfg.memoryImport, []);
    // shiftTemplate is a path inside the engine's own checkout, wherever that is installed.
    const json = JSON.stringify({ ...cfg, shiftTemplate: undefined });
    assert.doesNotMatch(json, /\bRan\b/, 'the owner\'s name in the generic config');
    const all = json.toLowerCase();
    for (const s of ['רן', 'hq.example.com', 'yoav', 'rotem', '100000001', 'owner-account', '8790']) {
      // A whole word: "רן" is also inside other words.
      assert.doesNotMatch(all, new RegExp(`(?<![\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u'), `"${s}" in the generic config`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#301: etaTimeZone is Asia/Jerusalem unless hq.config.json gives a valid IANA zone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-config-'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const load = (file: Record<string, unknown> | null) => {
      if (file) writeFileSync(join(dir, 'hq.config.json'), JSON.stringify(file));
      return loadConfig({ stateDir: dir, companyDir: join(dir, 'company') }).etaTimeZone;
    };
    assert.equal(load(null), 'Asia/Jerusalem');
    assert.equal(load({ etaTimeZone: 'Europe/London' }), 'Europe/London');
    assert.equal(load({ etaTimeZone: 'Mars/Olympus' }), 'Asia/Jerusalem');
    assert.equal(load({ etaTimeZone: 7 }), 'Asia/Jerusalem');
  } finally { console.warn = warn; rmSync(dir, { recursive: true, force: true }); }
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
    assert.deepEqual(both.auth.origins, ['https://x.example']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('COMPANY_HOME: one source for company/ and memory/, the legacy companyDir still works, nothing set = the engine repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-config-'));
  try {
    const home = join(dir, 'acme');
    mkdirSync(join(home, 'company'), { recursive: true });
    writeFileSync(join(home, 'company', 'org.yaml'), 'version: 1\nowner: dana\nmanager: noa\nidentities: []\n');
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state', 'hq.config.json'), JSON.stringify({ companyHome: home }));
    const prev = process.env.COMPANY_HOME;
    delete process.env.COMPANY_HOME; // a worker's shell has it (shift-host): this checks the file
    let cfg: HqConfig;
    try { cfg = loadConfig({ stateDir: join(dir, 'state') }); } finally { if (prev !== undefined) process.env.COMPANY_HOME = prev; }
    assert.deepEqual([cfg.companyHome, cfg.companyDir, cfg.managerId], [home, join(home, 'company'), 'noa'], 'org.yaml read from COMPANY_HOME');
    // First match wins: overrides, env, the file, the legacy companyDir/AGENT_COMPANY_DIR, the engine.
    const at = (o: Partial<HqConfig>, f: Partial<HqConfig>, env: NodeJS.ProcessEnv = {}) => companyLocation(o, f, env, '/eng');
    assert.deepEqual(at({}, {}), { companyHome: '/eng', companyDir: '/eng/company' });
    assert.deepEqual(at({}, {}, { AGENT_COMPANY_DIR: '/srv/a/company' }), { companyHome: '/srv/a', companyDir: '/srv/a/company' });
    assert.deepEqual(at({}, { companyDir: '/f/company' }, { AGENT_COMPANY_DIR: '/srv/a/company' }).companyHome, '/f');
    assert.deepEqual(at({}, { companyHome: '/h', companyDir: '/f/company' }).companyDir, '/h/company');
    assert.deepEqual(at({}, { companyHome: '/h' }, { COMPANY_HOME: '/e' }).companyHome, '/e');
    assert.deepEqual(at({ companyDir: '/t/company' }, { companyHome: '/h' }, { COMPANY_HOME: '/e' }).companyHome, '/t', 'a test override beats a worker\'s env');
    assert.deepEqual(at({ companyHome: '/o' }, {}, { COMPANY_HOME: '/e' }).companyHome, '/o');
    assert.equal(at({}, { companyHome: '~/c' }).companyHome, join(homedir(), 'c'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hq reads memory and runs registries in COMPANY_HOME, not companyDir/.. of the engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-chome-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'company', 'projects'), { recursive: true });
  writeFileSync(join(home, 'company', 'org.yaml'), ORG_YAML);
  mkdirSync(join(home, 'memory', 'company'), { recursive: true });
  writeFileSync(join(home, 'memory', 'company', 'zebra.md'), '# זברה\n\nzebrafact lives in COMPANY_HOME\n');
  const env = await makeEnv({ noStart: true, cfg: { companyHome: home } });
  try {
    assert.equal(env.cfg.companyDir, join(home, 'company'));
    const r = env.hq.ingest.recall({ identity: 'eli', shift: 'eli-1', query: 'zebrafact' });
    assert.equal(r.items[0]?.ref, 'memory/company/zebra.md');
    assert.equal(env.hq.memoryFiles.repoDir, home, 'registries and the memory PR go to the company repo');
  } finally { await env.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
