import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { alertmanagerCommand, amRound, parseAlerts, parseAmOutput, readAlertmanager, BLIND_MS, RESOLVE_AFTER_MS, type AmReading, type AmState } from '../src/alertmanager.ts';
import { parseCharterProbes, runAlertmanagerProbe } from '../src/probes.ts';

// The shape of Alertmanager v0.34's /api/v2/alerts in lumo-prod on 26/10 (no severity there), plus a critical one.
const alert = (fp: string, labels: Record<string, string>, summary?: string) => ({
  annotations: summary ? { summary } : {}, endsAt: '2026-10-26T17:48:36.971Z', fingerprint: fp, receivers: [{ name: 'none' }],
  startsAt: '2026-10-26T17:08:36.971Z', status: { inhibitedBy: [], mutedBy: [], silencedBy: [], state: 'active' }, updatedAt: '2026-10-26T17:44:36.970Z',
  generatorURL: 'http://prometheus:9090/graph', labels });
const LIST = JSON.stringify([
  alert('14b074e0a8f8f82f', { alertname: 'ListFailed', namespace: 'lumo-prod', pod: 'wabridge-9bb5dbf7d-jq7j2' }, 'member list(s) failed'),
  alert('aa00000000000001', { alertname: 'DbPrimaryDown', namespace: 'lumo-prod', severity: 'critical' }, 'אין primary ל-DB כבר 2 דקות'),
  alert('aa00000000000002', { alertname: 'NodeNotReady', node: 'vmi1000003', severity: 'warning' }),
]);
const block = (ns: string, body: string, rc = 0) => `@@am ns ${ns}\n${body}\n@@am rc ${rc}\n`;
const EMPTY: AmState = { open: {}, blind: {} };
const T = Date.UTC(2026, 9, 27, 9, 0, 0);

test('alertmanager: read-only command, only GET of the active, unsilenced, uninhibited list, per namespace', () => {
  const cmd = alertmanagerCommand(['lumo-prod', 'lumo-dev']);
  assert.match(cmd, /kubectl -n lumo-prod exec deploy\/alertmanager -- wget -qO- 'http:\/\/localhost:9093\/api\/v2\/alerts\?active=true&silenced=false&inhibited=false'/);
  assert.match(cmd, /kubectl -n lumo-dev exec/);
  assert.match(cmd, /timeout 20 kubectl -n lumo-prod exec/, 'one namespace that hangs is not every namespace');
  assert.doesNotMatch(cmd, /--post|POST|silences|-X/);
  assert.match(cmd, /rc=\$\?; echo; echo @@am rc \$rc/, 'the exit code is kubectl\'s, not echo\'s');
});

test('alertmanager: only severity=critical, with labels, summary and startsAt; anything else is not the list', () => {
  const a = parseAlerts(LIST)!;
  assert.deepEqual(a.map((x) => x.fingerprint), ['aa00000000000001']);
  assert.equal(a[0]!.summary, 'אין primary ל-DB כבר 2 דקות');
  assert.equal(a[0]!.labels.namespace, 'lumo-prod');
  assert.equal(a[0]!.startsAt, '2026-10-26T17:08:36.971Z');
  assert.deepEqual(parseAlerts('[]'), []);
  assert.equal(parseAlerts('wget: can\'t connect to remote host'), null);
  assert.equal(parseAlerts('{"status":"error"}'), null);
  assert.equal(parseAlerts('[{"labels":{}}]'), null, 'no fingerprint: not an alert list');
});

test('alertmanager: per namespace output; exec failed, no pod or garbage is an error there, not elsewhere', () => {
  const r = parseAmOutput(block('lumo-prod', LIST) + block('lumo-dev', 'Error from server (NotFound): deployments.apps "alertmanager" not found', 1) + block('x', 'garbage'),
    ['lumo-prod', 'lumo-dev', 'x', 'cut']);
  assert.equal((r['lumo-prod'] as unknown[]).length, 1);
  assert.match((r['lumo-dev'] as { error: string }).error, /kubectl exec נכשל \(1\).*NotFound/);
  assert.match((r.x as { error: string }).error, /לא מובנת/);
  assert.match((r.cut as { error: string }).error, /אין תשובה/);
});

test('alertmanager: ssh that failed → every namespace is unknown, never a failure', async () => {
  const calls: string[][] = [];
  const r = await readAlertmanager({ target: 'root@203.0.113.15', identityFile: '/k', namespaces: ['lumo-prod', 'lumo-dev'] }, 30_000,
    async (args) => { calls.push(args); throw new Error('ssh exit 255'); });
  assert.deepEqual(Object.keys(r), ['lumo-prod', 'lumo-dev']);
  for (const v of Object.values(r)) assert.match((v as { error: string }).error, /ssh נכשל: ssh exit 255/);
  assert.deepEqual(calls[0]!.slice(-3, -1), ['/k', 'root@203.0.113.15']);
});

test('alertmanager: a critical alert wakes once by fingerprint, with labels, summary and startsAt in UTC; one note when it is gone', () => {
  const crit = parseAlerts(LIST)!;
  const r1 = amRound('lumo/alerts', 'root@m', EMPTY, { 'lumo-prod': crit, 'lumo-dev': [] }, T);
  assert.equal(r1.messages.length, 1);
  const m = r1.messages[0]!;
  assert.equal(m.anomaly, true);
  assert.equal(m.priority, 'now');
  assert.match(m.body, /lumo-prod: DbPrimaryDown: אין primary ל-DB כבר 2 דקות/);
  assert.match(m.body, /התחילה: 2026-10-26 17:08:36 UTC/);
  assert.match(m.body, /labels: alertname=DbPrimaryDown, namespace=lumo-prod, severity=critical/);
  assert.match(m.body, /fingerprint: aa00000000000001/);
  const r2 = amRound('lumo/alerts', 'root@m', r1.state, { 'lumo-prod': crit, 'lumo-dev': [] }, T + 60_000);
  assert.equal(r2.messages.length, 0, 'still open: no second message');
  const r3a = amRound('lumo/alerts', 'root@m', r2.state, { 'lumo-prod': [], 'lumo-dev': [] }, T + 120_000);
  assert.equal(r3a.messages.length, 0, 'gone for less than resolve_after: still open');
  const r3 = amRound('lumo/alerts', 'root@m', r3a.state, { 'lumo-prod': [], 'lumo-dev': [] }, T + 120_000 + RESOLVE_AFTER_MS);
  assert.equal(r3.messages.length, 1);
  assert.equal(r3.messages[0]!.anomaly, false);
  assert.match(r3.messages[0]!.body, /התראה קריטית נעלמה[\s\S]*lumo-prod: DbPrimaryDown/);
  assert.deepEqual(r3.state.open, {});
  // The same fingerprint in another namespace is another alert.
  const r4 = amRound('lumo/alerts', 'root@m', r3.state, { 'lumo-prod': crit, 'lumo-dev': crit }, T + 180_000);
  assert.equal(r4.messages.length, 1);
  assert.match(r4.messages[0]!.body, /2 התראות חדשות/);
});

test('alertmanager: no answer keeps what is open; past 10 minutes one message "no sight", then one note when it is back', () => {
  const crit = parseAlerts(LIST)!;
  let s = amRound('lumo/alerts', 'root@m', EMPTY, { 'lumo-prod': crit, 'lumo-dev': [] }, T).state;
  const err = { error: 'ssh נכשל: ssh exit 255' };
  const all: string[] = [];
  for (let t = T + 60_000; t <= T + 60_000 + BLIND_MS + 120_000; t += 60_000) {
    const r = amRound('lumo/alerts', 'root@m', s, { 'lumo-prod': err, 'lumo-dev': err }, t);
    s = r.state;
    all.push(...r.messages.map((m) => m.body));
  }
  assert.equal(all.length, 1, 'one message for the blindness, no note that the alert is gone');
  assert.match(all[0]!, /אין ראייה ל-Alertmanager/);
  assert.match(all[0]!, /- lumo-prod: .*ssh exit 255/);
  assert.match(all[0]!, /- lumo-dev:/);
  assert.ok(s.open['lumo-prod/aa00000000000001'], 'still open: an unknown is not "gone"');
  const back = amRound('lumo/alerts', 'root@m', s, { 'lumo-prod': crit, 'lumo-dev': [] }, T + 30 * 60_000);
  assert.equal(back.messages.length, 1);
  assert.match(back.messages[0]!.body, /חזרה ראייה ל-Alertmanager ב-lumo-prod, lumo-dev/);
  assert.deepEqual(back.state.blind, {});
  // Ten minutes exactly is not over it; a short gap is never told, and its return isn't either.
  let q = amRound('k', 't', EMPTY, { a: err }, T).state;
  q = amRound('k', 't', q, { a: err }, T + BLIND_MS).state;
  assert.equal(amRound('k', 't', q, { a: [] }, T + BLIND_MS + 1).messages.length, 0);
});

test('alertmanager: a flapping alert (gone for a round, back) says nothing; gone for resolve_after, one note', () => {
  const crit = parseAlerts(LIST)!;
  const R = (s: AmState, prod: typeof crit, t: number) => amRound('lumo/alerts', 'root@m', s, { 'lumo-prod': prod, 'lumo-dev': [] }, t);
  let r = R(EMPTY, crit, T);
  assert.equal(r.messages.length, 1);
  // 26/10 20:40:42: missing for one round, back a minute later with another startsAt. No note, no new message.
  r = R(r.state, [], T + 60_000);
  assert.equal(r.messages.length, 0);
  assert.equal(r.state.open['lumo-prod/aa00000000000001']!.goneSince, T + 60_000);
  r = R(r.state, [{ ...crit[0]!, startsAt: '2026-10-26T20:40:45.000Z' }], T + 120_000);
  assert.equal(r.messages.length, 0);
  assert.equal(r.state.open['lumo-prod/aa00000000000001']!.goneSince, undefined, 'back: the hold-down clock starts over');
  // Gone for good: nothing until resolve_after, then exactly one note.
  const notes: string[] = [];
  for (let t = T + 180_000; t <= T + 180_000 + RESOLVE_AFTER_MS + 180_000; t += 60_000) {
    r = R(r.state, [], t);
    notes.push(...r.messages.map((m) => m.body));
  }
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /התראה קריטית נעלמה/);
  assert.match(notes[0]!, /נעלמה מהרשימה ב-2026-10-27 09:03:00 UTC/, 'when it went, not when the hold-down ended');
  // A namespace taken out of the charter while held down: dropped, no note.
  const held = R(R(EMPTY, crit, T).state, [], T + 60_000).state;
  const out = amRound('lumo/alerts', 'root@m', held, { 'lumo-dev': [] }, T + 60_000 + RESOLVE_AFTER_MS);
  assert.deepEqual([out.messages.length, out.state.open], [0, {}]);
  // A missing answer in the hold-down is not "gone" time lost: it stays open, and resolves by the time it went missing.
  let q = R(EMPTY, crit, T).state;
  q = R(q, [], T + 60_000).state;
  q = amRound('lumo/alerts', 'root@m', q, { 'lumo-prod': { error: 'x' }, 'lumo-dev': [] }, T + 120_000).state;
  assert.ok(q.open['lumo-prod/aa00000000000001']);
  assert.equal(R(q, [], T + 60_000 + RESOLVE_AFTER_MS).messages.length, 1);
  // resolve_after from the charter.
  const s0 = amRound('k', 't', EMPTY, { a: crit }, T).state;
  assert.equal(amRound('k', 't', s0, { a: [] }, T, { resolveAfterMs: 0 }).messages.length, 1);
  assert.match(amRound('k', 't', EMPTY, { a: crit }, T, { resolveAfterMs: 30_000 }).messages[0]!.body, /ל-30 שניות\./);
  assert.match(amRound('k', 't', EMPTY, { a: crit }, T, { resolveAfterMs: 60_000 }).messages[0]!.body, /ל-דקה\./);
});

test('alertmanager: a critical alert from a namespace with prod: false is later, not urgent, without "ask"; production is now', () => {
  const crit = parseAlerts(LIST)!;
  const r = amRound('lumo/alerts', 'root@m', EMPTY, { 'lumo-prod': [], 'lumo-dev': crit }, T, { nonProd: ['lumo-dev'] });
  assert.equal(r.messages.length, 1);
  const m = r.messages[0]!;
  assert.equal(m.priority, 'later');
  assert.equal(m.anomaly, false);
  assert.equal(m.event, 'probe.nonprod');
  assert.match(m.body, /מחוץ לפרודקשן/);
  assert.doesNotMatch(m.body, /ask|observe-only|פעולה על הפרודקשן/);
  const both = amRound('lumo/alerts', 'root@m', EMPTY, { 'lumo-prod': crit, 'lumo-dev': crit }, T, { nonProd: ['lumo-dev'] });
  assert.deepEqual(both.messages.map((x) => [x.priority, x.anomaly]), [['now', true], ['later', false]]);
  assert.doesNotMatch(both.messages[0]!.body, /lumo-dev/, 'the urgent one holds only production');
  // Its note and its blindness are later too.
  const gone = amRound('lumo/alerts', 'root@m', r.state, { 'lumo-prod': [], 'lumo-dev': [] }, T + RESOLVE_AFTER_MS, { nonProd: ['lumo-dev'] });
  assert.equal(gone.state.open['lumo-dev/aa00000000000001']!.goneSince, T + RESOLVE_AFTER_MS);
  const g2 = amRound('lumo/alerts', 'root@m', gone.state, { 'lumo-prod': [], 'lumo-dev': [] }, T + 2 * RESOLVE_AFTER_MS, { nonProd: ['lumo-dev'] });
  assert.equal(g2.messages[0]!.priority, 'later');
  assert.match(g2.messages[0]!.body, /- lumo-dev \(לא פרודקשן\): DbPrimaryDown/);
  let b = amRound('k', 't', EMPTY, { d: { error: 'x' } }, T, { nonProd: ['d'] }).state;
  const bm = amRound('k', 't', b, { d: { error: 'x' } }, T + BLIND_MS + 1, { nonProd: ['d'] }).messages;
  assert.deepEqual(bm.map((x) => [x.priority, x.anomaly]), [['later', false]]);
});

const CHARTER = `---
monitoring:
  - id: alerts
    alertmanager: root@203.0.113.15
    identity: ~/.ssh/lumo-cluster_ed25519
    namespaces: [lumo-prod, {name: lumo-dev, prod: false}]
    every: 1m
  - {id: no-ns, alertmanager: root@m}
  - {id: bad-ns, alertmanager: root@m, namespaces: ['lumo prod']}
  - {id: option, alertmanager: '-oProxyCommand=x', namespaces: [a]}
---
# lumo
`;

test('alertmanager probe: parsed with an explicit list of namespaces; without one, or with a bad one, it is unsupported', () => {
  const [p, ...bad] = parseCharterProbes('lumo', CHARTER);
  assert.equal(p!.kind, 'alertmanager');
  assert.deepEqual(p!.alertmanager!.namespaces, ['lumo-prod', 'lumo-dev']);
  assert.equal(p!.alertmanager!.target, 'root@203.0.113.15');
  assert.match(p!.alertmanager!.identityFile!, /\/\.ssh\/lumo-cluster_ed25519$/);
  assert.equal(p!.timeoutMs, 60_000);
  assert.deepEqual(p!.alertmanager!.nonProd, ['lumo-dev']);
  assert.equal(p!.alertmanager!.resolveAfterMs, RESOLVE_AFTER_MS);
  assert.deepEqual(bad.map((x) => x.kind), ['unsupported', 'unsupported', 'unsupported']);
  const [plain, badResolve] = parseCharterProbes('x', `---
monitoring:
  - {id: plain, alertmanager: root@m, namespaces: [a], resolve_after: 2m}
  - {id: bad-resolve, alertmanager: root@m, namespaces: [a], resolve_after: soon}
---
`);
  assert.deepEqual(plain!.alertmanager!.nonProd, [], 'a namespace is production unless it says prod: false');
  assert.equal(plain!.alertmanager!.resolveAfterMs, 120_000);
  assert.equal(badResolve!.kind, 'unsupported');
});

test('alertmanager probe: no namespace answered = unknown; one that answered is a reading, ok only without critical alerts', async () => {
  const [p] = parseCharterProbes('lumo', CHARTER);
  const u = await runAlertmanagerProbe(p!, async () => { throw new Error('ssh exit 255'); });
  assert.equal(u.unknown, true);
  const part = await runAlertmanagerProbe(p!, async () => block('lumo-prod', '[]'));
  assert.equal(part.unknown, undefined);
  assert.equal(part.ok, true);
  assert.ok('error' in (part.alerts!['lumo-dev'] as object));
  const crit = await runAlertmanagerProbe(p!, async () => block('lumo-prod', LIST) + block('lumo-dev', '[]'));
  assert.equal(crit.ok, false);
  const dev = await runAlertmanagerProbe(p!, async () => block('lumo-prod', '[]') + block('lumo-dev', LIST));
  assert.equal(dev.ok, true, 'a critical alert in prod: false does not fail the probe');
  assert.match(dev.error!, /lumo-dev\/DbPrimaryDown/);
  assert.match(crit.error!, /lumo-prod\/DbPrimaryDown/);
});

test('alertmanager probe in the runner: wakes רותם once (urgent), a note when gone, blindness after 10 minutes; a restart does not wake again', async () => {
  const env = await makeEnv({ projects: { lumo: CHARTER } });
  try {
    const { hq, clock } = env;
    let reading: AmReading | null = { 'lumo-prod': parseAlerts(LIST)!, 'lumo-dev': [] };
    hq.probes.run = async () => reading ? { ok: !(reading['lumo-prod'] as unknown[]).length, alerts: reading, status: null, latencyMs: 300, error: null }
      : { ok: false, unknown: true, alerts: { 'lumo-prod': { error: 'ssh exit 255' }, 'lumo-dev': { error: 'ssh exit 255' } }, status: null, latencyMs: 300, error: 'ssh exit 255' };
    const toRotem = () => hq.store.db.prepare(`SELECT kind, urgency, priority, body FROM messages WHERE to_identity = 'rotem' ORDER BY created_at`).all() as
      { kind: string; urgency: string; priority: string; body: string }[];
    for (let i = 0; i < 3; i++) { await hq.probes.tick(); clock.advance(61_000); }
    assert.equal(toRotem().length, 1);
    assert.equal(toRotem()[0]!.kind, 'probe_anomaly');
    assert.equal(toRotem()[0]!.urgency, 'urgent');
    assert.equal(toRotem()[0]!.priority, 'now');
    assert.match(toRotem()[0]!.body, /DbPrimaryDown/);
    assert.equal(hq.inbox.open().length, 0, 'not to the owner directly');
    // A restart: the state is in meta, the same alert does not wake her again.
    hq.probes.reload();
    await hq.probes.tick(); clock.advance(61_000);
    assert.equal(toRotem().length, 1);
    reading = null; // no sight: the alert stays open, no note
    for (let i = 0; i < 12; i++) { await hq.probes.tick(); clock.advance(61_000); }
    assert.equal(toRotem().length, 2);
    assert.match(toRotem()[1]!.body, /אין ראייה ל-Alertmanager/);
    reading = { 'lumo-prod': [], 'lumo-dev': [] };
    await hq.probes.tick();
    assert.equal(toRotem().length, 3, 'sight is back at once; the alert is held down for resolve_after');
    for (let i = 0; i < 6; i++) { clock.advance(61_000); await hq.probes.tick(); }
    const last = toRotem().slice(2).map((m) => m.body);
    assert.equal(last.length, 2);
    assert.ok(last.some((b) => /התראה קריטית נעלמה/.test(b)));
    assert.ok(last.some((b) => /חזרה ראייה/.test(b)));
    assert.equal((hq.store.db.prepare(`SELECT anomaly_open FROM probe_state WHERE probe_id = 'lumo/alerts'`).get() as { anomaly_open: number }).anomaly_open, 0);
    // From lumo-dev (prod: false): later, low, a system message; not anomaly_open.
    clock.advance(61_000);
    reading = { 'lumo-prod': [], 'lumo-dev': parseAlerts(LIST)! };
    await hq.probes.tick();
    const dev = toRotem().at(-1)!;
    assert.equal(toRotem().length, 5);
    assert.deepEqual([dev.kind, dev.urgency, dev.priority], ['system', 'low', 'later']);
    assert.match(dev.body, /מחוץ לפרודקשן/);
    assert.equal((hq.store.db.prepare(`SELECT anomaly_open FROM probe_state WHERE probe_id = 'lumo/alerts'`).get() as { anomaly_open: number }).anomaly_open, 0);
  } finally { await env.cleanup(); }
});
