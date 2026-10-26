// tab/passkeys.ts: every tab gets a virtual authenticator with the stored passkeys; a passkey a site registers is kept
// (0600) and spread to the other tabs; after Chrome comes back the tabs are covered again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PasskeyVault, type PasskeyCdp } from '../src/tab/passkeys.ts';

class FakeCdp implements PasskeyCdp {
  pagesNow = ['T1', 'T2'];
  calls: { method: string; params: any; sessionId?: string }[] = [];
  listeners = new Map<string, (m: string, p: any) => void>();
  failFor = new Set<string>();
  onTargetCreated = (_: string) => {};
  onTargetGone = (_: string) => {};
  onDisconnect = () => {};
  onConnect = () => {};
  async send(method: string, params: any = {}, sessionId?: string) {
    this.calls.push({ method, params, sessionId });
    if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: `A-${sessionId}` };
    return {};
  }
  async attach(targetId: string, listener: (m: string, p: any) => void) {
    if (this.failFor.has(targetId)) throw new Error('no such target');
    this.listeners.set(`S-${targetId}`, listener);
    return `S-${targetId}`;
  }
  async pages() { return this.pagesNow.map((targetId) => ({ targetId, url: 'https://x.example/' })); }
  close() {}
  added(sessionId: string) { return this.calls.filter((c) => c.method === 'WebAuthn.addCredential' && c.sessionId === sessionId); }
}

const cred = { credentialId: 'Y3JlZA', rpId: 'site.example', privateKey: 'cHJpdg', userHandle: 'dQ', signCount: 0, isResidentCredential: true, userName: 'ran' };
const tick = () => new Promise((r) => setImmediate(r));

test('passkeys: every tab gets an authenticator with no UI; a registered passkey is kept and spread', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pk-')), 'passkeys.json');
  const cdp = new FakeCdp();
  const vault = new PasskeyVault(file, cdp);
  await vault.coverAll();
  assert.equal(vault.covered, 2);
  const enable = cdp.calls.find((c) => c.method === 'WebAuthn.enable')!;
  assert.equal(enable.params.enableUI, false, 'no Chrome dialog: that is what the phone could not see');
  const opts = cdp.calls.find((c) => c.method === 'WebAuthn.addVirtualAuthenticator')!.params.options;
  assert.equal(opts.automaticPresenceSimulation, true);
  assert.equal(opts.isUserVerified, true);

  cdp.listeners.get('S-T1')!('WebAuthn.credentialAdded', { authenticatorId: 'A-S-T1', credential: cred });
  await tick();
  assert.equal(vault.passkeys.length, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the keys file is readable by its owner only');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).passkeys[0].rpId, 'site.example');
  assert.equal(cdp.added('S-T2').length, 1, 'the other tab gets it at once');
  assert.equal(cdp.added('S-T1').length, 0, 'not back into the tab that made it');
  assert.equal(cdp.added('S-T2')[0]!.params.credential.addedAt, undefined, 'only CDP fields go to Chrome');

  // A new tab gets what is stored.
  cdp.onTargetCreated('T3');
  await tick(); await tick(); await tick();
  assert.equal(cdp.added('S-T3').length, 1);

  // A sign-in bumps the counter, and it is kept.
  cdp.listeners.get('S-T2')!('WebAuthn.credentialAsserted', { authenticatorId: 'A-S-T2', credential: { ...cred, signCount: 3 } });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).passkeys[0].signCount, 3);
  vault.close();
});

test('passkeys: after Chrome restarts, the stored keys are back on every tab; a tab that cannot be covered is skipped', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pk-')), 'passkeys.json');
  const first = new FakeCdp();
  const v1 = new PasskeyVault(file, first);
  await v1.coverAll();
  first.listeners.get('S-T1')!('WebAuthn.credentialAdded', { authenticatorId: 'A-S-T1', credential: cred });
  v1.close();

  const cdp = new FakeCdp();
  cdp.pagesNow = ['T1', 'CHROME-SETTINGS'];
  cdp.failFor.add('CHROME-SETTINGS');
  const vault = new PasskeyVault(file, cdp);
  await vault.coverAll();
  assert.equal(vault.covered, 1);
  assert.equal(cdp.added('S-T1').length, 1, 'read back from the file');

  cdp.onDisconnect();
  assert.equal(vault.covered, 0);
  cdp.calls = [];
  cdp.onConnect();
  await tick(); await tick(); await tick(); await tick();
  assert.equal(vault.covered, 1, 'covered again after the connection came back');
  assert.equal(cdp.added('S-T1').length, 1);
  vault.close();
});

test('passkeys: a sign-in counter reaches the other tabs; a deletion too; an unreadable file is kept aside, not overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  const file = join(dir, 'passkeys.json');
  const cdp = new FakeCdp();
  const vault = new PasskeyVault(file, cdp);
  await vault.coverAll();
  cdp.listeners.get('S-T1')!('WebAuthn.credentialAdded', { authenticatorId: 'A-S-T1', credential: cred });
  await tick();
  cdp.calls = [];
  cdp.listeners.get('S-T1')!('WebAuthn.credentialAsserted', { authenticatorId: 'A-S-T1', credential: { ...cred, signCount: 4 } });
  await tick(); await tick();
  const t2 = cdp.calls.filter((c) => c.sessionId === 'S-T2').map((c) => c.method);
  assert.deepEqual(t2, ['WebAuthn.removeCredential', 'WebAuthn.addCredential'], 'tab 2 gets the key again with the new count');
  assert.equal(cdp.added('S-T2')[0]!.params.credential.signCount, 4, 'a counter that went back would read as a cloned key');
  assert.equal(cdp.calls.filter((c) => c.sessionId === 'S-T1').length, 0, 'the tab that signed in already has it');

  cdp.calls = [];
  cdp.listeners.get('S-T2')!('WebAuthn.credentialDeleted', { authenticatorId: 'A-S-T2', credentialId: cred.credentialId });
  await tick();
  assert.equal(vault.passkeys.length, 0);
  assert.deepEqual(cdp.calls.map((c) => [c.method, c.sessionId]), [['WebAuthn.removeCredential', 'S-T1']]);
  vault.close();

  writeFileSync(file, '{ not json');
  const logs: string[] = [];
  const again = new PasskeyVault(file, new FakeCdp(), (m) => logs.push(m));
  assert.equal(again.passkeys.length, 0);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('passkeys.json.unreadable-')), 'the only copy of the keys is kept aside');
  assert.ok(logs.some((m) => m.includes('unreadable')));
  again.close();
});

test('passkeys: our own removeCredential (Chrome reports it as deleted) does not delete the key everywhere', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pk-')), 'passkeys.json');
  const cdp = new FakeCdp();
  // Like Chrome: removing a credential fires credentialDeleted on that session before the reply.
  const send = cdp.send.bind(cdp);
  cdp.send = async (method: string, params: any = {}, sessionId?: string) => {
    if (method === 'WebAuthn.removeCredential') cdp.listeners.get(sessionId!)!('WebAuthn.credentialDeleted', { authenticatorId: params.authenticatorId, credentialId: params.credentialId });
    return send(method, params, sessionId);
  };
  const vault = new PasskeyVault(file, cdp);
  await vault.coverAll();
  cdp.listeners.get('S-T1')!('WebAuthn.credentialAdded', { authenticatorId: 'A-S-T1', credential: cred });
  cdp.listeners.get('S-T1')!('WebAuthn.credentialAsserted', { authenticatorId: 'A-S-T1', credential: { ...cred, signCount: 2 } });
  await tick(); await tick(); await tick();
  assert.equal(vault.passkeys.length, 1, 'still kept');
  assert.equal(cdp.calls.filter((c) => c.method === 'WebAuthn.removeCredential' && c.sessionId === 'S-T1').length, 0, 'and not removed from the tab that signed in');
  vault.close();
});
