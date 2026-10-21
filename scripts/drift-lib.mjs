#!/usr/bin/env node
// The judgement of scripts/drift-check.sh, in code that can be tested.
//
// Drift is production running something other than what was deployed and approved: files edited by hand in the
// checkout, a checkout that moved without a deploy (a manual `git pull`), live config that differs from main.
// Production BEHIND origin/main is not drift: "deploy only after GO". Those merged commits are reported as a summary
// (waiting for GO / a deploy, or merged and not deployed), never as an incident.
//
//   node scripts/drift-lib.mjs title < shorts   the owner's one line, from one short phrase per line
//   node scripts/drift-lib.mjs checkout|pending ...   used by drift-check.sh
import { execFileSync } from 'node:child_process';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const ok = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };

/**
 * What is wrong with the production checkout itself. `deployed` = the shas deploy.sh recorded (hq, app, caddy):
 * the checkout is exactly one of them after a deploy, whichever target it was.
 * @returns {{short: string, detail: string}[]}
 */
export function checkoutDrift(prod, deployed) {
  const out = [];
  const known = deployed.filter(Boolean);
  const head = git(prod, 'rev-parse', 'HEAD');
  const branch = git(prod, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') out.push({ short: 'התיקייה של השרת לא על הענף הראשי', detail: `ה-checkout בפרודקשן לא על main אלא על ${branch}` });
  const dirty = git(prod, 'status', '--porcelain').split('\n').filter(Boolean);
  if (dirty.length) out.push({ short: `${dirty.length === 1 ? 'קובץ' : dirty.length + ' קבצים'} בשרת שונו ביד`, detail: `ה-checkout בפרודקשן לא נקי: ${dirty.length} קבצים\n${dirty.slice(0, 10).map((l) => `    ${l}`).join('\n')}` });
  if (!known.length) {
    out.push({ short: 'אין רישום של פריסה: לא ברור מה רץ', detail: 'אין רישום של פריסה אחרונה (hq.sha): הקוד לא נפרס דרך scripts/deploy.sh' });
  } else if (!known.includes(head)) {
    const ahead = known.some((s) => ok(prod, 'merge-base', '--is-ancestor', s, head));
    out.push({
      short: ahead ? 'התיקייה של השרת עודכנה ידנית, בלי פריסה' : 'התיקייה של השרת לא על הגרסה שנפרסה',
      detail: `ה-checkout בפרודקשן ב-${head.slice(0, 7)}, והפריסה האחרונה ב-${known.map((s) => s.slice(0, 7)).join(', ')}` + (ahead ? ' (נראה כמו git pull ידני: ה-commits שנכנסו לא עברו אימות ולא אושרו ב-GO)' : ''),
    });
  }
  return out;
}

/**
 * Commits between what runs and origin/main, each as waiting (a GO is asked or given, or its task waits for a deploy)
 * or merged and not deployed. Memory-registry commits are memory, not code, and are left out (as deploy.sh does).
 * @returns {{sha: string, subject: string, pr: string|null, waiting: boolean}[]}
 */
export function pendingCommits(prod, from, main, waitingPrs) {
  if (!from || !ok(prod, 'cat-file', '-e', `${from}^{commit}`) || !ok(prod, 'cat-file', '-e', `${main}^{commit}`)) return [];
  const log = git(prod, 'log', '--format=%H%x09%s', '--invert-grep', '-E', '--grep=^Company-Memory-Registry: ', `${from}..${main}`);
  const want = new Set(waitingPrs.map(String));
  return log.split('\n').filter(Boolean).map((l) => {
    const [sha, ...rest] = l.split('\t');
    const subject = rest.join('\t');
    const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? null;
    return { sha, subject, pr, waiting: !!pr && want.has(pr) };
  });
}

/** The summary lines: what is merged and not live, and why it is not a problem. */
export function pendingLines(commits) {
  const lines = [];
  const w = commits.filter((c) => c.waiting);
  const n = commits.filter((c) => !c.waiting);
  if (w.length) lines.push(`מוזגו וממתינים ל-GO או לפריסה (${w.length}):`, ...w.map((c) => `  ${c.subject}`));
  if (n.length) lines.push(`מוזגו ולא נפרסו (${n.length}):`, ...n.map((c) => `  ${c.subject}`));
  return lines;
}

/** One line in the owner's words, no shas, no paths: what is wrong, from the first item's `short`. */
export function incidentTitle(items) {
  if (items.length === 1) return `בפרודקשן: ${items[0].short}`;
  return `בפרודקשן: ${items[0].short}, ועוד ${items.length - 1}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'title') {
    let s = '';
    process.stdin.on('data', (c) => (s += c)).on('end', () => {
      const items = s.split('\n').filter(Boolean).map((l) => ({ short: l }));
      console.log(items.length ? incidentTitle(items) : '');
    });
  } else if (cmd === 'checkout') { // <prod> <deployed shas...>: "short<TAB>detail" lines
    const [prod, ...deployed] = a;
    for (const i of checkoutDrift(prod, deployed)) console.log(`${i.short}\t${i.detail.replaceAll('\n', ' ⏎ ')}`);
  } else if (cmd === 'pending') { // <prod> <deployed> <main> <waiting prs...>
    const [prod, from, main, ...prs] = a;
    console.log(pendingLines(pendingCommits(prod, from, main, prs)).join('\n'));
  }
}
