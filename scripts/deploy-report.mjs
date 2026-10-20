#!/usr/bin/env node
// After a verified deploy, tells hq which merged PRs (and hq tasks) are now in production, so "מה לבדוק"
// (#108) drops what waited for a deploy: POST /api/deploys. Run by scripts/deploy.sh; never fails the deploy.
//
// A PR counts as deployed only when every part it touches is live at or after it: packages/app → the app
// release, deploy/caddy → Caddy, docs/research → nothing to deploy, anything else → hq. So an app-only PR
// stays waiting through an `hq` deploy. The live sha of each part:
//   hq    <state>/deploy/hq.sha               app   /var/www/hq-app/current/.deployed-sha
//   caddy <state>/deploy/caddy.sha
// The task of a PR is its branch, company-t<id> (hq names every task branch so), from one `gh pr list`.
//
//   node scripts/deploy-report.mjs <target> <sha>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'agent-company';
export const REPO = 'hivecode-app/hive-code';
const LOOKBACK = 100;

/** Which deployed parts a changed path needs: hq | app | caddy, or none (docs). */
export function partOf(path) {
  if (path.startsWith('packages/app/')) return 'app';
  if (path.startsWith('deploy/caddy/')) return 'caddy';
  if (/^(docs|research|spikes)\//.test(path) || /^[^/]+\.md$/.test(path)) return null;
  return 'hq';
}

/** `subject (#12)` → "12" (a squash merge); else null. */
export function prOf(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? m[1] : null;
}

/**
 * The PRs among `commits` (newest first: {sha, subject, files}) that are fully live. `live(part, sha)` says
 * whether that part runs a version that contains the commit.
 */
export function deployedPrs(commits, live) {
  const out = [];
  for (const c of commits) {
    const pr = prOf(c.subject);
    if (!pr) continue;
    const parts = [...new Set(c.files.map(partOf).filter(Boolean))];
    if (parts.every((p) => live(p, c.sha))) out.push(pr);
  }
  return out;
}

/** company-t<id> branches → hq task ids, for the PRs given. */
export function tasksOf(prs, merged) {
  const want = new Set(prs);
  return merged.filter((p) => want.has(String(p.number))).map((p) => /^company-t(\d+)$/.exec(p.headRefName)?.[1])
    .filter(Boolean).map(Number);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function main() {
  const [target, sha] = process.argv.slice(2);
  if (!target || !sha) { console.error('usage: deploy-report.mjs <target> <sha>'); process.exit(2); }
  const state = process.env.AGENT_COMPANY_STATE ?? join(homedir(), '.local', 'state', 'agent-company');
  const read = (f) => { try { return readFileSync(f, 'utf8').trim() || null; } catch { return null; } };
  const liveSha = {
    hq: read(join(state, 'deploy', 'hq.sha')),
    app: read('/var/www/hq-app/current/.deployed-sha'),
    caddy: read(join(state, 'deploy', 'caddy.sha')),
  };
  const contains = (tip, c) => { try { git('merge-base', '--is-ancestor', c, tip); return true; } catch { return false; } };
  const commits = git('log', `-n${LOOKBACK}`, '--format=%H%x09%s', sha).split('\n').filter(Boolean).map((l) => {
    const [h, ...s] = l.split('\t');
    return { sha: h, subject: s.join('\t'), files: git('diff-tree', '--no-commit-id', '--name-only', '-r', h).split('\n').filter(Boolean) };
  });
  const prs = deployedPrs(commits, (part, c) => !!liveSha[part] && contains(liveSha[part], c));
  let tasks = [];
  try {
    const merged = JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', REPO, '--state', 'merged', '--limit', String(LOOKBACK),
      '--json', 'number,headRefName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }));
    tasks = tasksOf(prs, merged);
  } catch { /* gh missing or offline: PR numbers alone still match tasks that gave theirs */ }
  const token = process.env.HQ_TOKEN ?? read(join(state, 'api-token'));
  const res = await fetch(`${process.env.HQ_URL ?? 'http://127.0.0.1:7420'}/api/deploys`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project: PROJECT, sha, target, prs, tasks }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`hq ${res.status}: ${await res.text()}`);
  const { deploy } = await res.json();
  console.log(deploy.cleared.length ? `ירדו מ"מה לבדוק": ${deploy.cleared.map((t) => `t${t}`).join(', ')}` : 'אין משימות שחיכו לפריסה הזו');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`הדיווח ל-hq נכשל: ${e.message}`); process.exit(1); });
}
