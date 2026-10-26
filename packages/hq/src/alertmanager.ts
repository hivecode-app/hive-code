// `alertmanager` probe (lumo root 6, 27/10): the cluster's own alerts reach רותם. Read-only, over the ssh the `cluster` probe uses:
// per namespace in the charter, `kubectl exec deploy/alertmanager -- wget -qO-` of /api/v2/alerts (active, not silenced, not inhibited).
// Only GET: no POST, no silences. A critical alert (labels.severity == "critical") wakes רותם once by its fingerprint, and one note
// when it is gone from the list. ssh or exec that failed, no alertmanager pod, garbage: that namespace is unknown, not a failure,
// and its open alerts stay as they were. Unknown for more than BLIND_MS: one separate message, "no sight of Alertmanager".
import { runSsh, q, type SshRun } from './nodes.ts';

export interface AlertmanagerSpec { target: string; identityFile: string | null; namespaces: string[] }

export interface AmAlert { fingerprint: string; labels: Record<string, string>; summary: string | null; startsAt: string }

/** Per namespace: its critical alerts, or why there is no answer from it. */
export type AmReading = Record<string, AmAlert[] | { error: string }>;

export const AM_PATH = 'http://localhost:9093/api/v2/alerts?active=true&silenced=false&inhibited=false';
/** Without an answer from a namespace this long, רותם hears that there is no sight of it. */
export const BLIND_MS = 10 * 60_000;

const NS = /^[a-z0-9][a-z0-9-]*$/;
export const isNamespace = (s: string): boolean => NS.test(s) && s.length <= 63;

const MARK = '@@am';
/** Per namespace: one exec that hangs is that namespace's unknown (exit 124), not every namespace's (ssh killed). */
export const NS_TIMEOUT_S = 20;

/** The remote command: one block per namespace, its output and kubectl's exit code. */
export function alertmanagerCommand(namespaces: string[]): string {
  return namespaces.map((ns) => `echo ${MARK} ns ${ns}; timeout ${NS_TIMEOUT_S} kubectl -n ${ns} exec deploy/alertmanager -- wget -qO- ${q(AM_PATH)} 2>&1; rc=$?; echo; echo ${MARK} rc $rc`).join('; ');
}

/** Alertmanager's v2 list → the critical ones. null when it isn't that list. */
export function parseAlerts(body: string): AmAlert[] | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(j)) return null;
  const out: AmAlert[] = [];
  for (const a of j) {
    if (!a || typeof a !== 'object') return null;
    const r = a as { fingerprint?: unknown; labels?: unknown; annotations?: unknown; startsAt?: unknown };
    if (typeof r.fingerprint !== 'string' || !r.labels || typeof r.labels !== 'object') return null;
    const labels = Object.fromEntries(Object.entries(r.labels as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    if (labels.severity !== 'critical') continue;
    const summary = (r.annotations as { summary?: unknown } | undefined)?.summary;
    out.push({ fingerprint: r.fingerprint, labels, summary: typeof summary === 'string' ? summary : null, startsAt: typeof r.startsAt === 'string' ? r.startsAt : '' });
  }
  return out;
}

/** The ssh output → a reading per namespace. A namespace with no block (the command was cut short) has an error too. */
export function parseAmOutput(out: string, namespaces: string[]): AmReading {
  const reading: AmReading = {};
  const blocks = out.split(`${MARK} ns `).slice(1);
  for (const b of blocks) {
    const nl = b.indexOf('\n');
    const ns = b.slice(0, nl < 0 ? undefined : nl).trim();
    if (!namespaces.includes(ns)) continue;
    const rest = nl < 0 ? '' : b.slice(nl + 1);
    const rc = new RegExp(`${MARK} rc (\\d+)\\s*$`).exec(rest);
    const body = rc ? rest.slice(0, rc.index).trim() : rest.trim();
    if (!rc) { reading[ns] = { error: `אין קוד יציאה מ-kubectl: ${body.slice(0, 120) || '(ריק)'}` }; continue; }
    if (rc[1] !== '0') { reading[ns] = { error: `kubectl exec נכשל (${rc[1]}): ${body.slice(0, 160) || '(ריק)'}` }; continue; }
    const alerts = parseAlerts(body);
    reading[ns] = alerts ?? { error: `תשובה לא מובנת מ-Alertmanager: ${body.slice(0, 120) || '(ריק)'}` };
  }
  for (const ns of namespaces) if (!(ns in reading)) reading[ns] = { error: 'אין תשובה מה-namespace הזה' };
  return reading;
}

/** Read-only, one ssh for every namespace. An ssh that failed: every namespace has that error. */
export async function readAlertmanager(a: AlertmanagerSpec, timeoutMs: number, run: SshRun = runSsh): Promise<AmReading> {
  try {
    const out = await run(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
      ...(a.identityFile ? ['-i', a.identityFile] : []), a.target, alertmanagerCommand(a.namespaces)], undefined, timeoutMs);
    return parseAmOutput(out, a.namespaces);
  } catch (e) {
    const error = `ssh נכשל: ${(e as Error).message}`;
    return Object.fromEntries(a.namespaces.map((ns) => [ns, { error }]));
  }
}

/** What is open per probe: the critical alerts already told (by `<ns>/<fingerprint>`), and the namespaces with no answer. */
export interface AmState { open: Record<string, { ns: string; alertname: string; summary: string | null }>; blind: Record<string, { since: number; told: boolean; error: string }> }

export interface AmMessage { id: string; anomaly: boolean; priority: 'now' | 'next'; body: string }

const utc = (s: string): string => { const t = Date.parse(s); return Number.isFinite(t) ? `${new Date(t).toISOString().replace('T', ' ').slice(0, 19)} UTC` : s || '—'; };

/** One reading against what was open: the new state and what goes to רותם. Pure, so the rules are tested without ssh. */
export function amRound(key: string, target: string, prev: AmState, reading: AmReading, now: number, toOwner = 'לרן'): { state: AmState; messages: AmMessage[] } {
  const state: AmState = { open: { ...prev.open }, blind: { ...prev.blind } };
  const messages: AmMessage[] = [];
  const fresh: { ns: string; a: AmAlert }[] = [];
  const gone: string[] = [];
  const back: string[] = [];
  for (const [ns, r] of Object.entries(reading)) {
    if (!Array.isArray(r)) {
      // No answer: the open alerts of this namespace stay as they were. Its clock of blindness starts or goes on.
      const b = state.blind[ns] ?? { since: now, told: false, error: r.error };
      state.blind[ns] = { ...b, error: r.error };
      continue;
    }
    if (state.blind[ns]?.told) back.push(ns);
    delete state.blind[ns];
    const now_ = new Set(r.map((a) => `${ns}/${a.fingerprint}`));
    for (const a of r) if (!state.open[`${ns}/${a.fingerprint}`]) {
      fresh.push({ ns, a });
      state.open[`${ns}/${a.fingerprint}`] = { ns, alertname: a.labels.alertname ?? '?', summary: a.summary };
    }
    for (const [k, o] of Object.entries(state.open)) if (o.ns === ns && !now_.has(k)) { gone.push(k); delete state.open[k]; }
  }
  // Namespaces no longer in the charter: what was open there is dropped without a note (no one is watching them now).
  for (const k of Object.keys(state.open)) if (!(state.open[k]!.ns in reading)) delete state.open[k];
  for (const ns of Object.keys(state.blind)) if (!(ns in reading)) delete state.blind[ns];

  if (fresh.length) messages.push({ id: `probe-${key}-${now}`, anomaly: true, priority: 'now', body: [
    `התראה קריטית מ-Alertmanager: ${key} (${target}), ${fresh.length === 1 ? 'התראה אחת חדשה' : `${fresh.length} התראות חדשות`}:`,
    ...fresh.flatMap(({ ns, a }) => [
      `- ${ns}: ${a.labels.alertname ?? '?'}${a.summary ? `: ${a.summary}` : ''}`,
      `  התחילה: ${utc(a.startsAt)}`,
      `  labels: ${Object.entries(a.labels).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `  fingerprint: ${a.fingerprint}`,
    ]),
    'התראה אחת לכל fingerprint: כל עוד היא פתוחה לא תצא עליה עוד הודעה, ויצא note כשהיא נעלמת מהרשימה.',
    `שלב 1: observe-only. חקרי, ושלחי ${toOwner} ask דחוף עם השערה והצעה. פעולה על הפרודקשן רק עם grant באמנה.`,
  ].join('\n') });
  if (gone.length) messages.push({ id: `probe-${key}-recovered-${now}`, anomaly: false, priority: 'next', body: [
    `${key}: ${gone.length === 1 ? 'התראה קריטית נעלמה' : `${gone.length} התראות קריטיות נעלמו`} מ-Alertmanager:`,
    ...gone.map((k) => { const o = prev.open[k]!; return `- ${o.ns}: ${o.alertname}${o.summary ? `: ${o.summary}` : ''}`; }),
  ].join('\n') });
  const blind = Object.entries(state.blind).filter(([, b]) => !b.told && now - b.since > BLIND_MS);
  if (blind.length) {
    for (const [ns, b] of blind) state.blind[ns] = { ...b, told: true };
    messages.push({ id: `probe-${key}-blind-${now}`, anomaly: true, priority: 'now', body: [
      `אין ראייה ל-Alertmanager: ${key} (${target}), כבר יותר מ-${BLIND_MS / 60_000} דקות:`,
      ...blind.map(([ns, b]) => `- ${ns}: מ-${utc(new Date(b.since).toISOString())}. ${b.error}`),
      'זה לא אומר שיש תקלה, אלא שהתראות קריטיות מה-namespace הזה לא יגיעו אלייך עד שהראייה חוזרת.',
    ].join('\n') });
  }
  if (back.length) messages.push({ id: `probe-${key}-sight-${now}`, anomaly: false, priority: 'next',
    body: `${key}: חזרה ראייה ל-Alertmanager ב-${back.join(', ')}.` });
  return { state, messages };
}
