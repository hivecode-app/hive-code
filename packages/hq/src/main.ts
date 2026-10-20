#!/usr/bin/env node
// `company hq` — run the central process (B.1). Node ≥ 24 runs this TypeScript directly (type stripping).
//   node packages/hq/src/main.ts [--port 7420] [--host 127.0.0.1] [--state DIR] [--company DIR]
//   node packages/hq/src/main.ts backup      # one-off sqlite backup, then exit
//   node packages/hq/src/main.ts token       # print the API token (creates it on first run)
//   node packages/hq/src/main.ts pair        # one-time pairing code + link for a new device (10 min)
//   node packages/hq/src/main.ts pair --qr   # the same, and the link as a QR for the phone's camera (scripts/install.sh)
import { parseArgs } from 'node:util';
import { renderUnicodeCompact } from 'uqr';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Hq, loadForeignInjector } from './hq.ts';
import { backupOnce } from './backup.ts';
import { loadOrCreateToken } from './api.ts';
import { Store } from './store.ts';
import { Auth } from './auth.ts';
import { hhmm, readTimeZone } from './timezone.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' }, host: { type: 'string' }, state: { type: 'string' }, company: { type: 'string' },
    qr: { type: 'boolean' },
  },
});
const args = positionals[0] === 'hq' ? positionals.slice(1) : positionals;

const cfg = loadConfig({
  ...(values.state ? { stateDir: values.state } : {}),
  ...(values.company ? { companyDir: values.company } : {}),
});
if (values.port) cfg.port = Number(values.port);
if (values.host) cfg.host = values.host;

if (args[0] === 'token') {
  console.log(loadOrCreateToken(cfg.stateDir));
  process.exit(0);
}

if (args[0] === 'pair') {
  // Opens the store directly: works whether or not hq is running (WAL, one short write).
  const store = new Store(cfg.dbPath);
  const p = new Auth(store, cfg.auth).createPairCode({ kind: 'admin' });
  store.close();
  console.log(`code: ${p.code}  (valid until ${hhmm(p.expires_at, readTimeZone(cfg.companyDir))})`);
  if (p.link) console.log(`link: ${p.link}`);
  if (p.link && values.qr) console.log(`\n${renderUnicodeCompact(p.link, { border: 2 })}`);
  process.exit(0);
}

const hq = new Hq(cfg, { foreign: await loadForeignInjector() });

if (args[0] === 'backup') {
  console.log(await backupOnce(hq.store, join(cfg.stateDir, 'backups'), cfg.backupsKeep));
  hq.store.close();
  process.exit(0);
}

await hq.start();
console.log(`company hq listening on http://${cfg.host}:${hq.port} (state ${cfg.stateDir}, company ${cfg.companyDir})`);

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await hq.stop();
    process.exit(0);
  });
}
