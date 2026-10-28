// `alertmanager` probe (lumo root 6, 27/10): the cluster's own alerts reach רותם. Read-only, over the ssh the `cluster` probe uses:
// per namespace in the charter, `kubectl exec deploy/alertmanager -- wget -qO-` of /api/v2/alerts (active, not silenced, not inhibited).
// Only GET: no POST, no silences. A critical alert (labels.severity == "critical") wakes רותם once by its fingerprint, and one note
// when it has been gone from the list for `resolve_after` (5m): one that flaps (gone for a round, then back) says nothing more.
// A namespace marked `prod: false` in the charter (lumo-dev) is not production: its alerts reach her at `later`, not urgent and not as
// a production anomaly (the mailbox still delivers it, a resting shift included, like any message from hq). ssh or exec that failed, no alertmanager pod, garbage: that namespace is unknown, not a failure,
// and its open alerts stay as they were. Unknown for more than BLIND_MS: one separate message, "no sight of Alertmanager".
// One cluster's Alertmanager can carry another project's alerts (lumobot's in lumo-prod, 28/10): `match` keeps only the alerts whose
// labels have every key=value of it, `exclude` drops those matching any of its selectors (so the two probes don't both tell), and
// `critical`/`warning` name alerts by alertname (a named one is that severity whatever its label says). A warning goes out at `next`,
// not urgent. `notify` is who the probe's messages go to (else רותם), `cc` who gets a copy of each.
import { runSsh, q, type SshRun } from './nodes.ts';

export type LabelSelector = Record<string, string>;

/** Which alerts of the list are this probe's, and how severe. Without any of it: every alert labelled severity=critical. */
export interface AmFilter { match?: LabelSelector; exclude?: LabelSelector[]; critical?: string[]; warning?: string[] }

export interface AlertmanagerSpec extends AmFilter { target: string; identityFile: string | null; namespaces: string[]; nonProd?: string[]; resolveAfterMs?: number;
  notify?: string; cc?: string[] }

export type AmSeverity = 'critical' | 'warning';

export interface AmAlert { fingerprint: string; labels: Record<string, string>; summary: string | null; startsAt: string; severity: AmSeverity }

const selects = (sel: LabelSelector, labels: Record<string, string>): boolean => Object.entries(sel).every(([k, v]) => labels[k] === v);

/** The severity this probe gives the alert, or null when it isn't this probe's. */
export function amSeverity(labels: Record<string, string>, f: AmFilter = {}): AmSeverity | null {
  if (f.match && !selects(f.match, labels)) return null;
  if (f.exclude?.some((s) => selects(s, labels))) return null;
  const name = labels.alertname ?? '';
  if (f.critical?.includes(name)) return 'critical';
  if (f.warning?.includes(name)) return 'warning';
  return labels.severity === 'critical' ? 'critical' : null;
}

/** Per namespace: this probe's alerts, or why there is no answer from it. */
export type AmReading = Record<string, AmAlert[] | { error: string }>;

export const AM_PATH = 'http://localhost:9093/api/v2/alerts?active=true&silenced=false&inhibited=false';
/** Without an answer from a namespace this long, רותם hears that there is no sight of it. */
export const BLIND_MS = 10 * 60_000;
/** An alert gone from the list this long is gone (hold-down): Alertmanager drops one for a round while its rule re-evaluates. */
export const RESOLVE_AFTER_MS = 5 * 60_000;

const NS = /^[a-z0-9][a-z0-9-]*$/;
export const isNamespace = (s: string): boolean => NS.test(s) && s.length <= 63;

const MARK = '@@am';
/** Per namespace: one exec that hangs is that namespace's unknown (exit 124), not every namespace's (ssh killed). */
export const NS_TIMEOUT_S = 20;

/** The remote command: one block per namespace, its output and kubectl's exit code. */
export function alertmanagerCommand(namespaces: string[]): string {
  return namespaces.map((ns) => `echo ${MARK} ns ${ns}; timeout ${NS_TIMEOUT_S} kubectl -n ${ns} exec deploy/alertmanager -- wget -qO- ${q(AM_PATH)} 2>&1; rc=$?; echo; echo ${MARK} rc $rc`).join('; ');
}

/** Alertmanager's v2 list → this probe's alerts (amSeverity). null when it isn't that list. */
export function parseAlerts(body: string, filter: AmFilter = {}): AmAlert[] | null {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(j)) return null;
  const out: AmAlert[] = [];
  for (const a of j) {
    if (!a || typeof a !== 'object') return null;
    const r = a as { fingerprint?: unknown; labels?: unknown; annotations?: unknown; startsAt?: unknown };
    if (typeof r.fingerprint !== 'string' || !r.labels || typeof r.labels !== 'object') return null;
    const labels = Object.fromEntries(Object.entries(r.labels as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const severity = amSeverity(labels, filter);
    if (!severity) continue;
    const summary = (r.annotations as { summary?: unknown } | undefined)?.summary;
    out.push({ fingerprint: r.fingerprint, labels, summary: typeof summary === 'string' ? summary : null, startsAt: typeof r.startsAt === 'string' ? r.startsAt : '', severity });
  }
  return out;
}

/** The ssh output → a reading per namespace. A namespace with no block (the command was cut short) has an error too. */
export function parseAmOutput(out: string, namespaces: string[], filter: AmFilter = {}): AmReading {
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
    const alerts = parseAlerts(body, filter);
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
    return parseAmOutput(out, a.namespaces, a);
  } catch (e) {
    const error = `ssh נכשל: ${(e as Error).message}`;
    return Object.fromEntries(a.namespaces.map((ns) => [ns, { error }]));
  }
}

/** What is open per probe: the alerts already told (`warning` for one told as a warning) (by `<ns>/<fingerprint>`; `goneSince` while it is missing from the list
 *  but not yet `resolve_after`), and the namespaces with no answer. */
export interface AmState { open: Record<string, { ns: string; alertname: string; summary: string | null; warning?: true; goneSince?: number }>; blind: Record<string, { since: number; told: boolean; error: string }> }

export interface AmMessage { id: string; anomaly: boolean; priority: 'now' | 'next' | 'later'; body: string; event: 'probe.anomaly' | 'probe.warning' | 'probe.recovered' | 'probe.nonprod' }

export interface AmOptions { toOwner?: string; nonProd?: string[]; resolveAfterMs?: number }

const span = (ms: number): string => ms % 60_000 ? `${Math.round(ms / 1000)} שניות` : ms === 60_000 ? 'דקה' : `${ms / 60_000} דקות`;
const utc = (s: string): string => { const t = Date.parse(s); return Number.isFinite(t) ? `${new Date(t).toISOString().replace('T', ' ').slice(0, 19)} UTC` : s || '—'; };

/** One reading against what was open: the new state and what goes to רותם. Pure, so the rules are tested without ssh. */
export function amRound(key: string, target: string, prev: AmState, reading: AmReading, now: number, opts: AmOptions = {}): { state: AmState; messages: AmMessage[] } {
  const toOwner = opts.toOwner ?? 'לרן';
  const nonProd = new Set(opts.nonProd ?? []);
  const resolveAfter = opts.resolveAfterMs ?? RESOLVE_AFTER_MS;
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
    for (const a of r) {
      const k = `${ns}/${a.fingerprint}`;
      const o = state.open[k];
      if (!o) {
        fresh.push({ ns, a });
        state.open[k] = { ns, alertname: a.labels.alertname ?? '?', summary: a.summary, ...(a.severity === 'warning' ? { warning: true as const } : {}) };
      } else if (o.warning && a.severity === 'critical') {
        // Told as a warning, critical now (the charter's lists changed while it was open): it is told again, as critical.
        fresh.push({ ns, a });
        state.open[k] = { ns, alertname: a.labels.alertname ?? '?', summary: a.summary };
      } else if (o.goneSince != null) {
        // Back within resolve_after: it never resolved, nothing to say.
        const { goneSince: _, ...still } = o;
        state.open[k] = still;
      }
    }
    for (const [k, o] of Object.entries(state.open)) {
      if (o.ns !== ns || now_.has(k)) continue;
      const since = o.goneSince ?? now;
      if (now - since >= resolveAfter) { gone.push(k); delete state.open[k]; } else state.open[k] = { ...o, goneSince: since };
    }
  }
  // Namespaces no longer in the charter: what was open there is dropped without a note (no one is watching them now).
  for (const k of Object.keys(state.open)) if (!(state.open[k]!.ns in reading)) delete state.open[k];
  for (const ns of Object.keys(state.blind)) if (!(ns in reading)) delete state.blind[ns];

  const prodFresh = fresh.filter((f) => !nonProd.has(f.ns) && f.a.severity === 'critical');
  const warnFresh = fresh.filter((f) => !nonProd.has(f.ns) && f.a.severity === 'warning');
  const devFresh = fresh.filter((f) => nonProd.has(f.ns));
  const lines = (list: typeof fresh) => list.flatMap(({ ns, a }) => [
    `- ${ns}${a.severity === 'warning' && list !== warnFresh ? ' (אזהרה)' : ''}: ${a.labels.alertname ?? '?'}${a.summary ? `: ${a.summary}` : ''}`,
    `  התחילה: ${utc(a.startsAt)}`,
    `  labels: ${Object.entries(a.labels).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `  fingerprint: ${a.fingerprint}`,
  ]);
  const once = `התראה אחת לכל fingerprint: כל עוד היא פתוחה לא תצא עליה עוד הודעה, ויצא note כשהיא נעלמת מהרשימה${resolveAfter > 0 ? ` ל-${span(resolveAfter)}` : ''}.`;
  if (prodFresh.length) messages.push({ id: `probe-${key}-${now}`, anomaly: true, priority: 'now', event: 'probe.anomaly', body: [
    `התראה קריטית מ-Alertmanager: ${key} (${target}), ${prodFresh.length === 1 ? 'התראה אחת חדשה' : `${prodFresh.length} התראות חדשות`}:`,
    ...lines(prodFresh),
    once,
    `שלב 1: observe-only. חקרי, ושלחי ${toOwner} ask דחוף עם השערה והצעה. פעולה על הפרודקשן רק עם grant באמנה.`,
  ].join('\n') });
  if (devFresh.length) messages.push({ id: `probe-${key}-nonprod-${now}`, anomaly: false, priority: 'later', event: 'probe.nonprod', body: [
    `${devFresh.some((f) => f.a.severity === 'warning') ? 'התראה' : 'התראה קריטית'} מ-Alertmanager מחוץ לפרודקשן: ${key} (${target}), ${devFresh.length === 1 ? 'התראה אחת חדשה' : `${devFresh.length} התראות חדשות`}:`,
    ...lines(devFresh),
    once,
    'ה-namespace מסומן באמנה prod: false, ולכן זה לא דחוף: לבדוק כשיש זמן.',
  ].join('\n') });
  if (warnFresh.length) messages.push({ id: `probe-${key}-warning-${now}`, anomaly: false, priority: 'next', event: 'probe.warning', body: [
    `אזהרה מ-Alertmanager: ${key} (${target}), ${warnFresh.length === 1 ? 'אזהרה אחת חדשה' : `${warnFresh.length} אזהרות חדשות`}:`,
    ...lines(warnFresh),
    once,
    'זו אזהרה ולא תקלה: לבדוק אם היא חוזרת או מצטרפת להתראה קריטית. פעולה על הפרודקשן רק עם grant באמנה.',
  ].join('\n') });
  if (gone.length) messages.push({ id: `probe-${key}-recovered-${now}`, anomaly: false, event: 'probe.recovered',
    priority: gone.every((k) => nonProd.has(prev.open[k]!.ns) || prev.open[k]!.warning) ? 'later' : 'next', body: [
      `${key}: ${gone.length === 1 ? `${prev.open[gone[0]!]!.warning ? 'אזהרה' : 'התראה קריטית'} נעלמה` : `${gone.length} ${gone.every((k) => prev.open[k]!.warning) ? 'אזהרות' : gone.some((k) => prev.open[k]!.warning) ? 'התראות' : 'התראות קריטיות'} נעלמו`} מ-Alertmanager:`,
      ...gone.map((k) => { const o = prev.open[k]!; return `- ${o.ns}${nonProd.has(o.ns) ? ' (לא פרודקשן)' : ''}${o.warning ? ' (אזהרה)' : ''}: ${o.alertname}${o.summary ? `: ${o.summary}` : ''}. נעלמה מהרשימה ב-${utc(new Date(o.goneSince ?? now).toISOString())}`; }),
    ].join('\n') });
  const blind = Object.entries(state.blind).filter(([, b]) => !b.told && now - b.since > BLIND_MS);
  if (blind.length) {
    for (const [ns, b] of blind) state.blind[ns] = { ...b, told: true };
    const prodBlind = blind.some(([ns]) => !nonProd.has(ns));
    messages.push({ id: `probe-${key}-blind-${now}`, anomaly: prodBlind, priority: prodBlind ? 'now' : 'later', event: prodBlind ? 'probe.anomaly' : 'probe.nonprod', body: [
      `אין ראייה ל-Alertmanager: ${key} (${target}), כבר יותר מ-${BLIND_MS / 60_000} דקות:`,
      ...blind.map(([ns, b]) => `- ${ns}${nonProd.has(ns) ? ' (לא פרודקשן)' : ''}: מ-${utc(new Date(b.since).toISOString())}. ${b.error}`),
      'זה לא אומר שיש תקלה, אלא שהתראות מה-namespace הזה לא יגיעו אלייך עד שהראייה חוזרת.',
    ].join('\n') });
  }
  if (back.length) messages.push({ id: `probe-${key}-sight-${now}`, anomaly: false, priority: back.every((ns) => nonProd.has(ns)) ? 'later' : 'next', event: 'probe.recovered',
    body: `${key}: חזרה ראייה ל-Alertmanager ב-${back.join(', ')}.` });
  return { state, messages };
}
