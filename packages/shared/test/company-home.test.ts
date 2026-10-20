import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyDirOf, configuredCompanyHome, ENGINE_ROOT, memoryDirOf, resolveCompanyHome, shiftCompanyHome } from '../src/company-home.ts';

test('COMPANY_HOME: env, then hq.config.json companyHome (or its legacy companyDir), then the engine repo', () => {
  const state = mkdtempSync(join(tmpdir(), 'chome-'));
  try {
    const at = (env: NodeJS.ProcessEnv = {}) => resolveCompanyHome({ env, stateRoot: state });
    assert.equal(at(), ENGINE_ROOT, 'nothing configured: the engine repo, as before the split');
    assert.equal(resolveCompanyHome({ env: {}, stateRoot: state, fallback: '/eng' }), '/eng');
    writeFileSync(join(state, 'hq.config.json'), JSON.stringify({ companyDir: '/srv/acme/company' }));
    assert.equal(at(), '/srv/acme', 'a legacy companyDir: its parent');
    writeFileSync(join(state, 'hq.config.json'), JSON.stringify({ companyHome: '~/company', companyDir: '/srv/acme/company' }));
    assert.equal(at(), join(homedir(), 'company'), 'companyHome wins, ~ expanded');
    assert.equal(at({ COMPANY_HOME: '/env/home/' }), '/env/home', 'env wins');
    assert.equal(at({ COMPANY_HOME: '  ' }), join(homedir(), 'company'), 'an empty env var is not set');
    assert.equal(at({ COMPANY_STATE_DIR: '/nope' }), join(homedir(), 'company'), 'an explicit stateRoot beats the env');
    assert.equal(resolveCompanyHome({ env: { COMPANY_STATE_DIR: state } }), join(homedir(), 'company'), 'the state dir of a shift');
    writeFileSync(join(state, 'hq.config.json'), '{ broken');
    assert.equal(configuredCompanyHome(state), null);
    assert.equal(companyDirOf('/h'), '/h/company');
    assert.equal(memoryDirOf('/h'), '/h/memory');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a shift reads COMPANY_HOME at every start: a restart follows the split and a rollback', () => {
  const state = mkdtempSync(join(tmpdir(), 'chome-'));
  try {
    assert.equal(shiftCompanyHome(undefined, {}, state), null, 'not configured: no COMPANY_HOME, the engine repo as before');
    writeFileSync(join(state, 'hq.config.json'), JSON.stringify({ companyHome: '/srv/company' }));
    assert.equal(shiftCompanyHome(undefined, {}, state), '/srv/company', 'after the split');
    writeFileSync(join(state, 'hq.config.json'), JSON.stringify({}));
    assert.equal(shiftCompanyHome(undefined, {}, state), null, 'after a rollback');
    assert.equal(shiftCompanyHome(undefined, { COMPANY_HOME: '~/c' }, state), join(homedir(), 'c'));
    assert.equal(shiftCompanyHome(' /arg ', { COMPANY_HOME: '/env' }, state), '/arg');
  } finally { rmSync(state, { recursive: true, force: true }); }
});
