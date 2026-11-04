#!/usr/bin/env node
// A recoverable daily pair: online SQLite snapshot and the company repository, including local work.
import { mkdirSync, readdirSync, renameSync, rmSync, chmodSync, statfsSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const CACHES = new Set(['node_modules', '.worktrees', '.dart_tool', '.gradle']);
function treeBytes(path, root = path, backupRoot = '') {
  if (resolve(path) === resolve(backupRoot || '/does-not-exist')) return 0;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  return readdirSync(path).reduce((sum, name) => sum + (CACHES.has(name) || (path === root && name === '.git') ? 0 : treeBytes(join(path, name), root, backupRoot)), 0);
}
export async function dailyBackup(state, company, now = new Date(), options = {}) {
  const root = join(state, 'daily-backups');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const free = options.freeBytes ?? (path => { const fs = statfsSync(path); return fs.bavail * fs.bsize; });
  const dbFile = join(state, 'hq.db');
  // Conservative uncompressed estimate, SQLite snapshot and a 64MB reserve. Never fill the last blocks.
  const objects = execFileSync('git', ['-C', company, 'count-objects', '-v'], { encoding: 'utf8' });
  const historyBytes = [...objects.matchAll(/^size(?:-pack)?: (\d+)$/gm)].reduce((n, m) => n + Number(m[1]) * 1024, 0);
  const need = historyBytes * 2 + treeBytes(company, company, root) * 2 + (lstatSync(dbFile).size + (existsSync(`${dbFile}-wal`) ? lstatSync(`${dbFile}-wal`).size : 0)) * 2 + 64 * 1024 * 1024;
  if (free(root) < need) throw new Error('Not enough disk space for a complete daily backup');
  const day = now.toISOString().slice(0, 10);
  const temp = join(root, `.${day}-${process.pid}`), out = join(root, day);
  mkdirSync(temp, { mode: 0o700 });
  try {
    const db = new Database(join(state, 'hq.db'), { readonly: true, fileMustExist: true });
    try { await db.backup(join(temp, 'hq.db')); } finally { db.close(); }
    chmodSync(join(temp, 'hq.db'), 0o600);
    let hasHistory = false;
    try { execFileSync('git', ['-C', company, 'rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }); hasHistory = true; } catch { /* First install: archive the working files, no commits yet. */ }
    if (hasHistory) execFileSync('git', ['-C', company, 'bundle', 'create', join(temp, 'company.bundle'), '--all'], { stdio: 'pipe' });
    else writeFileSync(join(temp, 'NO-GIT-HISTORY.txt'), 'No commits existed at backup time. Initialize a new repository and extract company.tar.gz.\n', { mode: 0o600 });
    const excludes = ['--exclude=./.git', ...[...CACHES].map(name => `--exclude=${name}`)];
    const underCompany = relative(resolve(company), resolve(root));
    if (underCompany && !underCompany.startsWith('..')) excludes.push(`--exclude=./${underCompany}`);
    execFileSync('tar', ['-czf', join(temp, 'company.tar.gz'), ...excludes, '-C', company, '.'], { stdio: 'pipe' });
    // A complete previous snapshot stays intact if any command above fails.
    // Unique suffix permits multiple successful backups on the same day without deleting first.
    const dest = `${out}-${now.getTime()}`;
    renameSync(temp, dest);
    const copies = readdirSync(root).filter(f => /^\d{4}-\d{2}-\d{2}-\d+$/.test(f)).sort().reverse();
    const days = new Set();
    for (const f of copies) {
      const key = f.slice(0, 10), keep = !days.has(key) && days.size < 7;
      days.add(key);
      if (!keep) rmSync(join(root, f), { recursive: true });
    }
    return dest;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [state, company] = process.argv.slice(2);
  if (!state || !company) { console.error('usage: daily-backup.mjs <state> <company>'); process.exitCode = 2; }
  else dailyBackup(state, company).then(console.log).catch(e => { console.error(e.message); process.exitCode = 1; });
}
