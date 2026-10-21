#!/usr/bin/env node
// The engine-side steps of `company update` (scripts/company-update.sh). Each runs from the engine it is about: the
// update script calls the NEW engine's copy, so the new engine checks the company, migrates a copy of hq.db and names
// its own Claude Code version before anything is switched.
//   node scripts/engine.mjs latest-tag <git-url>          the highest vX.Y.Z tag there (nothing printed: no tag)
//   node scripts/engine.mjs pinned-claude                  the Claude Code version this engine is pinned to
//   node scripts/engine.mjs org-plan <companyHome>         ok | migrate <from> <to> | newer <from> <to> | missing ...
//   node scripts/engine.mjs org-migrate <companyHome>      rewrites <companyHome>/company/org.yaml to this engine's format;
//                                                           prints the PR body (Hebrew)
//   node scripts/engine.mjs db-backup <hq.db> <out>        online copy (SQLite backup API, safe while hq runs)
//   node scripts/engine.mjs db-migrate-dry <copy>          runs this engine's hq.db migrations on <copy>: "<before> <after>"
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ORG_VERSION, orgPlan, migrateOrg } from './org-migrations.mjs';

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** "1.2.10" > "1.2.9": the highest vX.Y.Z among `git ls-remote --tags` lines, or null. Pre-releases (v1.2.0-rc1) are skipped. */
export function latestTag(lsRemote) {
  const tags = [...lsRemote.matchAll(/refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/gm)]
    .map((m) => ({ tag: m[1], v: [Number(m[2]), Number(m[3]), Number(m[4])] }));
  tags.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return tags.at(-1)?.tag ?? null;
}

/** PINNED_VERSION from an engine's packages/adapter/src/binary.ts (read as text: no import of the adapter needed). */
export function pinnedClaude(engineRoot = engine) {
  const src = readFileSync(join(engineRoot, 'packages/adapter/src/binary.ts'), 'utf8');
  const v = /export const PINNED_VERSION = '([^']+)'/.exec(src)?.[1];
  if (!v) throw new Error(`אין PINNED_VERSION ב-${engineRoot}`);
  return v;
}

/** The PR body for an org.yaml migration (Hebrew, the company's own repo). */
export function migrationBody(plan) {
  return [
    `עדכון המנוע דורש את הפורמט של \`org.yaml\` בגרסה ${plan.to} (עכשיו ${plan.from}).`,
    '',
    ...plan.steps.map((s) => `- **${s.to}:** ${s.title}`),
    '',
    'נפתח על ידי `company update`. העדכון ממתין: אחרי המיזוג מריצים שוב `company update`.',
  ].join('\n');
}

const HQ_STOP_REASONS = new Set(['rest', 'task_done', 'owner_stop', 'resurrect', 'unresponsive', 'stuck', 'brief_failed', 'node_fallback']);

/** Runs `fn` on a read-only hq.db; `fallback` when it is not there (a fresh install) or cannot be read. */
async function dbOr(file, fn, fallback) {
  if (!existsSync(file)) return fallback;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return fn(db); } catch { return fallback; } finally { db.close(); }
}

async function main([cmd, ...a]) {
  switch (cmd) {
    case 'latest-tag': {
      const out = execFileSync('git', ['ls-remote', '--tags', '--refs', a[0]], { encoding: 'utf8' });
      const t = latestTag(out);
      if (t) console.log(t);
      return;
    }
    case 'pinned-claude':
      console.log(pinnedClaude());
      return;
    case 'org-plan': {
      const p = orgPlan(readFileSync(join(a[0], 'company/org.yaml'), 'utf8'));
      console.log(p.action === 'missing' ? `missing ${p.from} ${p.to} ${p.missing}` : `${p.action} ${p.from} ${p.to}`);
      return;
    }
    case 'org-migrate': {
      const file = join(a[0], 'company/org.yaml');
      const text = readFileSync(file, 'utf8');
      const plan = orgPlan(text);
      writeFileSync(file, migrateOrg(text, plan));
      console.log(migrationBody(plan));
      return;
    }
    case 'db-backup': {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(a[0], { readonly: true, fileMustExist: true });
      await db.backup(a[1]);
      db.close();
      chmodSync(a[1], 0o600);
      return;
    }
    case 'db-migrate-dry': {
      const { default: Database } = await import('better-sqlite3');
      const raw = new Database(a[0], { fileMustExist: true });
      const before = raw.pragma('user_version', { simple: true });
      raw.close();
      const { Store } = await import('../packages/hq/src/store.ts');
      const s = new Store(a[0]);
      const after = s.schemaVersion;
      s.close();
      console.log(`${before} ${after}`);
      return;
    }
    case 'events-seq': {
      // The newest event seq in hq.db (0 when there is no db): a mark taken before hq restarts.
      console.log(await dbOr(a[0], (db) => db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).get().n, 0));
      return;
    }
    case 'shifts-rested': {
      // The shift units hq itself ended on purpose after event seq a[1] (rest, task_done, owner_stop...): their last
      // shift.state is `ended` with one of the reasons hq itself passes to shifts.stop (packages/hq/src). Anything else
      // (no_result, crashed, spawn_failed, crash: ...) is the shift dying, so it stays a fall. A unit that is gone
      // without such a record fell.
      const rows = await dbOr(a[0], (db) => db.prepare(`SELECT data FROM events WHERE type = 'shift.state' AND seq > ? ORDER BY seq`).all(Number(a[1])), []);
      const last = new Map();
      for (const r of rows) { try { const d = JSON.parse(r.data); if (d.shift) last.set(d.shift, d); } catch { /* not ours */ } }
      for (const [id, d] of last) if (d.state === 'ended' && HQ_STOP_REASONS.has(d.reason)) console.log(`company-shift@${id}.service`);
      return;
    }
    case 'org-version':
      console.log(ORG_VERSION);
      return;
    default:
      console.error('usage: engine.mjs latest-tag|pinned-claude|org-plan|org-migrate|db-backup|db-migrate-dry|events-seq|shifts-rested|org-version');
      process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
