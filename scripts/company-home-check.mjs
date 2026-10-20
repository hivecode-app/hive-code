// verify-prod's check that hq and every live worker read the company (contract, memory) from COMPANY_HOME, and not
// from the engine repo. Forgetting one place is silent otherwise: the engine repo still has an old memory/ until the
// split's last step (docs/generic/PLAN.md §1 step 3). Pure: verify-prod passes in what it read from /proc.
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Where a live company-mcp reads memory from: COMPANY_HOME, else COMPANY_REPO, else its cwd (mcp-company server.ts). */
export const readerHome = (env, cwd) => env.COMPANY_HOME || env.COMPANY_REPO || cwd || null;

const inside = (p, root) => p === root || p.startsWith(root + sep);

/**
 * home: the COMPANY_HOME production resolves; engineRoot: this checkout; hqHome: where hq reads it (its config, its env);
 * readers: [{ shift, home }] per live company-mcp. Returns [{ ok, line }] in Hebrew.
 */
export function companyHomeFindings({ home, engineRoot, hqHome, readers, exists = existsSync }) {
  const out = [];
  const add = (ok, good, bad = good) => out.push({ ok, line: ok ? good : bad });
  const split = home !== engineRoot;
  if (!split) add(true, `COMPANY_HOME לא מוגדר: החברה והזיכרון עוד בתוך repo המנוע (${engineRoot})`);
  else {
    add(!inside(home, engineRoot), `COMPANY_HOME הוא ${home}, מחוץ ל-repo המנוע`, `COMPANY_HOME (${home}) בתוך repo המנוע (${engineRoot})`);
    const missing = ['company/org.yaml', 'memory'].filter((f) => !exists(join(home, f)));
    add(!missing.length, `ב-${home} יש company/org.yaml ו-memory/`, `ב-${home} חסרים: ${missing.join(', ')}`);
  }
  add(hqHome === home, `hq קורא את החברה מ-${home}`, `hq קורא את החברה מ-${hqHome}, ולא מ-${home}`);
  const wrong = readers.filter((r) => r.home !== home);
  if (!readers.length) add(true, 'אין משמרות חיות: אין עובד לבדוק מאיפה הוא קורא זיכרון');
  else add(!wrong.length, `כל ${readers.length} המשמרות החיות קוראות זיכרון מ-${home}`,
    `${wrong.length} משמרות קוראות זיכרון לא מ-${home}: ${wrong.map((r) => `${r.shift} (${r.home ?? 'לא ידוע'})`).join(', ')}. `
    + 'הפעלה מחדש של המשמרת מתקנת (systemctl --user restart company-shift@<shift>)');
  return out;
}

/** Live company-mcp processes of this user: their shift and where they read memory from. Linux /proc.
 *  Only processes in this one's mount namespace: an install test's container on the same host (its own
 *  manager-1, its own COMPANY_HOME) shows up in /proc too, and is not a shift of this company. */
export function liveReaders(proc = '/proc') {
  const out = [];
  let pids = [];
  try { pids = readdirSync(proc).filter((p) => /^\d+$/.test(p)); } catch { return out; }
  let mine = null;
  try { mine = readlinkSync(`${proc}/self/ns/mnt`); } catch { /* no namespaces here: every process counts */ }
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`${proc}/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(`mcp-company${sep}src${sep}server.ts`)) continue;
      if (mine && readlinkSync(`${proc}/${pid}/ns/mnt`) !== mine) continue;
      const env = procEnv(pid, proc);
      if (!env.COMPANY_SHIFT) continue;
      let cwd = null;
      try { cwd = readlinkSync(`${proc}/${pid}/cwd`); } catch { /* gone */ }
      out.push({ shift: env.COMPANY_SHIFT, home: readerHome(env, cwd) });
    } catch { /* not ours, or gone */ }
  }
  return out;
}

/** A process's environment from /proc, or {} (gone, not ours). */
export function procEnv(pid, proc = '/proc') {
  try {
    return Object.fromEntries(readFileSync(`${proc}/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  } catch { return {}; }
}
