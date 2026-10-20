#!/usr/bin/env node
// `company doctor [<file>] [--no-verify]`: everything support needs to understand an install, in one text file, without
// secrets (docs/generic/PLAN.md §5). Versions, the units, the last hq and shift logs, verify-prod, disk and memory, the
// public address. Nothing is sent anywhere: the owner reads the file and sends it himself. No telemetry.
// What is never read: the shifts' transcripts (*.ndjson: conversations), hq.db's content, credentials. What is read
// and might hold a secret (logs, config) goes through redact(), which also removes every known secret of this install
// by value (api-token, hq.env, vapid.json).
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveCompanyHome } from '../packages/shared/src/company-home.ts';
import { orgVersion } from './org-migrations.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HIDDEN = '[הוסתר]';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, HIDDEN],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, HIDDEN],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, `$1${HIDDEN}`],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${HIDDEN}`],
  // Any key that names a secret (DICTATE_TOKEN=, access_token:, client_secret=, sessionToken=). A bare number stays:
  // counts like input_tokens: 1200 are what support reads.
  [/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api_?key|private_?key|credentials?)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\[)(?!\d+(?![\w.+/=-]))("[^"]*"|'[^']*'|\S+)/gi, `$1$2${HIDDEN}`],
  [/("(?:[A-Za-z_]*(?:token|secret|password|privateKey|private_key|apiKey|api_key|credentials?))"\s*:\s*)"[^"]*"/gi, `$1"${HIDDEN}"`],
  [/([?&](?:code|token|key|secret|auth)=)[^&\s"'<>]+/gi, `$1${HIDDEN}`],
  // Opaque random strings (base64url, 32+ characters with upper, lower and digits). Pure hex stays: git shas
  // and sha256 digests are what support needs, and hex secrets of this install are removed by value.
  // Not inside a path or a dotted name (/home/Dana1/..., file.ts:431): those are separated by / and . anyway.
  [/(?<![A-Za-z0-9_+/.-])(?=[A-Za-z0-9_+-]*[A-Z])(?=[A-Za-z0-9_+-]*[a-z])(?=[A-Za-z0-9_+-]*\d)[A-Za-z0-9_+-]{32,}={0,2}(?![A-Za-z0-9_+/.-])/g, HIDDEN],
  // Standard base64 has / and +, like a path; it is told apart by a + or by its = padding, which paths do not have.
  [/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)(?:(?=[A-Za-z0-9/]*\+)[A-Za-z0-9+/]{32,}={0,2}|[A-Za-z0-9+/]{32,}={1,2})(?![A-Za-z0-9+/=])/g, HIDDEN],
];

/** Removes secrets from text: every value in `known` (literal), then the patterns above. */
export function redact(text, known = []) {
  let out = String(text);
  for (const k of [...new Set(known)].filter((k) => typeof k === 'string' && k.length >= 8).sort((a, b) => b.length - a.length)) {
    out = out.split(k).join(HIDDEN);
  }
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** The secret values of this install, read only to be removed from the report. */
export function knownSecrets(state, configDir) {
  const out = [];
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
  const tok = read(join(state, 'api-token'));
  if (tok) out.push(tok.trim());
  const env = read(join(configDir, 'hq.env'));
  for (const m of env?.matchAll(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/gm) ?? []) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
  const vapid = read(join(state, 'vapid.json'));
  if (vapid) {
    try { for (const v of Object.values(JSON.parse(vapid))) if (typeof v === 'string') out.push(v); } catch { /* not JSON */ }
  }
  return out;
}

function sh(cmd, args, { timeout = 20_000, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, env: env ?? process.env, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return `(${cmd}: ${r.error.code === 'ETIMEDOUT' ? `לא הסתיים תוך ${timeout / 1000} שניות` : r.error.message})`;
  const out = `${r.stdout ?? ''}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}`.trimEnd();
  return r.status === 0 ? out : `${out}${out ? '\n' : ''}(קוד יציאה ${r.status})`;
}

const readOr = (f, alt = '(אין)') => { try { return readFileSync(f, 'utf8').trimEnd(); } catch { return alt; } };
const linkOr = (f) => { try { return readlinkSync(f); } catch { return '(אין)'; } };
const sizeOf = (f) => { try { return `${(statSync(f).size / 1048576).toFixed(1)} MB`; } catch { return '(אין)'; } };

/**
 * The report, as text, before redaction. `run(cmd, args, opts)` runs a command and returns its output (tests pass a
 * fake). `verify`: run verify-prod (it pairs and revokes a test device against the public address).
 */
export function buildReport({ run = sh, state, configDir, data, engine = engineRoot, home = homedir(), verify = true, now = new Date() }) {
  const parts = [];
  const section = (title, body) => parts.push(`\n## ${title}\n\n${String(body).trimEnd() || '(ריק)'}`);
  const cfg = (() => { try { return JSON.parse(readFileSync(join(state, 'hq.config.json'), 'utf8')); } catch { return {}; } })();
  const companyHome = resolveCompanyHome({ stateRoot: state, fallback: engine, env: { ...process.env, AGENT_COMPANY_STATE: state } });
  const pinned = /export const PINNED_VERSION = '([^']+)'/.exec(readOr(join(engine, 'packages/adapter/src/binary.ts'), ''))?.[1] ?? '(לא ידוע)';
  const claudeBin = join(data, 'claude', 'current', 'claude');

  parts.push(`# company doctor\n\nנוצר: ${now.toISOString()} · מכונה: ${hostname()}\n`
    + 'הקובץ נוצר מקומית ולא נשלח לשום מקום. סודות ידועים הוסתרו, ותמלילי שיחות לא נקראו. כדאי לעבור עליו לפני ששולחים.');

  section('גרסאות', [
    `מנוע: ${engine}`,
    `engine/current: ${linkOr(join(data, 'engine', 'current'))}`,
    `git: ${run('git', ['-C', engine, 'describe', '--tags', '--always', '--dirty'])} (${run('git', ['-C', engine, 'rev-parse', '--abbrev-ref', 'HEAD'])})`,
    `node: ${process.version}`,
    `Claude Code: נעול ל-${pinned}, current → ${linkOr(join(data, 'claude', 'current'))}, ${existsSync(claudeBin) ? run(claudeBin, ['--version'], { env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }) : '(לא מותקן)'}`,
    `מערכת: ${/^PRETTY_NAME="?([^"\n]*)"?/m.exec(readOr('/etc/os-release', ''))?.[1] ?? '?'} · kernel ${run('uname', ['-r'])}`,
    `systemd: ${run('systemctl', ['--version']).split('\n')[0]}`,
    `gh: ${run('gh', ['--version']).split('\n')[0]}`,
  ].join('\n'));

  let org = '(אין org.yaml)';
  try { org = `פורמט ${orgVersion(readFileSync(join(companyHome, 'company/org.yaml'), 'utf8'))}`; } catch (e) { if (existsSync(join(companyHome, 'company/org.yaml'))) org = e.message; }
  section('החברה', [
    `COMPANY_HOME: ${companyHome}${companyHome === engine ? ' (בתוך repo המנוע)' : ''}`,
    `git: ${run('git', ['-C', companyHome, 'log', '-1', '--format=%h %cI %s'])}`,
    `שינויים לא מקומטים: ${run('git', ['-C', companyHome, 'status', '--porcelain']).split('\n').filter(Boolean).length}`,
    `org.yaml: ${org}`,
    '',
    'company check:',
    run('node', [join(engine, 'scripts/check-contract.mjs'), companyHome], { timeout: 60_000 }).split('\n').slice(-15).join('\n'),
  ].join('\n'));

  const unitNames = ['agent-company-hq.service', 'agent-company-web.service', 'agent-company-drift.timer', 'actions-runner-company.service'];
  section('יחידות', [
    run('systemctl', ['--user', 'show', ...unitNames, '-p', 'Id,LoadState,ActiveState,SubState,NRestarts,ActiveEnterTimestamp,FragmentPath']),
    '',
    'משמרות:',
    run('systemctl', ['--user', 'list-units', 'company-shift@*', '--all', '--plain', '--no-legend']),
    '',
    `linger: ${run('loginctl', ['show-user', String(process.getuid?.() ?? ''), '-p', 'Linger'])}`,
    `/health: ${run('curl', ['-s', '-m', '5', 'http://127.0.0.1:7420/health'])}`,
  ].join('\n'));

  const apiUrl = typeof cfg.apiUrl === 'string' ? cfg.apiUrl.replace(/\/+$/, '') : null;
  section('כתובת ציבורית', [
    `apiUrl: ${apiUrl ?? '(לא מוגדר ב-hq.config.json)'} · appUrl: ${cfg.auth?.appUrl ?? '(לא מוגדר)'}`,
    apiUrl ? `${apiUrl}/health מבחוץ: ${run('curl', ['-s', '-o', '/dev/null', '-m', '10', '-w', '%{http_code} %{time_total}s', `${apiUrl}/health`])}` : '',
    `caddy (מערכת): ${run('systemctl', ['is-active', 'caddy'])}`,
    `cloudflared: ${run('systemctl', ['is-active', 'cloudflared'])}`,
    `tailscale funnel:\n${run('tailscale', ['funnel', 'status'], { timeout: 10_000 })}`,
  ].filter(Boolean).join('\n'));

  section('אימות מקצה לקצה (verify-prod)', verify
    ? run('node', [join(engine, 'scripts/verify-prod.mjs')], { timeout: 180_000, env: { ...process.env, COMPANY_STATE: state } })
    : '(דולג: --no-verify)');

  section('משאבים', [
    run('df', ['-h', '/', home, state]),
    '',
    `hq.db: ${sizeOf(join(state, 'hq.db'))} · גיבויים: ${(() => { try { return readdirSync(join(state, 'backups')).filter((f) => f.endsWith('.db')).length; } catch { return 0; } })()}`,
    run('du', ['-sh', state], { timeout: 30_000 }),
    '',
    run('free', ['-m']),
    `עומס: ${readOr('/proc/loadavg')} · ליבות: ${run('nproc', [])}`,
  ].join('\n'));

  section('פריסה ועדכון אחרונים', [
    'deploy:', readOr(join(state, 'deploy', 'last-summary.txt')), '', 'update:', readOr(join(state, 'update', 'last-summary.txt')),
  ].join('\n'));

  section('לוג hq (300 שורות אחרונות)', run('journalctl', ['--user', '-u', 'agent-company-hq', '-n', '300', '--no-pager', '-o', 'short-iso']));
  const shifts = run('systemctl', ['--user', 'list-units', 'company-shift@*', '--state=active', '--plain', '--no-legend'])
    .split('\n').map((l) => l.split(/\s+/)[0]).filter((u) => /^company-shift@[\w.-]+\.service$/.test(u));
  section('לוגים של המשמרות (stderr של shift-host, 40 שורות לכל משמרת, בלי התמלילים)', shifts.length
    ? shifts.map((u) => `### ${u}\n${run('journalctl', ['--user', '-u', u, '-n', '40', '--no-pager', '-o', 'short-iso'])}`).join('\n\n')
    : 'אין משמרות פעילות');
  return parts.join('\n') + '\n';
}

function main(argv) {
  const verify = !argv.includes('--no-verify');
  const file = resolve(argv.find((a) => !a.startsWith('--'))
    ?? `company-doctor-${new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '')}.txt`);
  const state = process.env.COMPANY_STATE ?? join(homedir(), '.local/state/agent-company');
  const configDir = join(homedir(), '.config/agent-company');
  const data = process.env.AGENT_COMPANY_DATA ?? join(homedir(), '.local/share/agent-company');
  const report = redact(buildReport({ state, configDir, data, verify }), knownSecrets(state, configDir));
  writeFileSync(file, report, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`נכתב: ${file} (${Math.ceil(Buffer.byteLength(report) / 1024)} KB)`);
  console.log('הוא לא נשלח לשום מקום. כדאי לעבור עליו, ורק אז לשלוח אותו למי שעוזר.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
