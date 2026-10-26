import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, until } from './helpers.ts';
import { parseCharterProbes } from '../src/probes.ts';
import { parseSnapshot, evaluate, workload, queryTables, isSshTarget, CLUSTER_SCRIPT, type History, type Snapshot } from '../src/root-signals.ts';

// The three roots of 26/10/2026 that no alert caught (m-1793030059228-29), replayed from what was measured that day:
// (1) six kubelets 1.34 against apiserver 1.33 on the shared cluster: task-697's per-node PATCH/min and the apiserver's
//     request mix (GET pods 34.2% + PATCH pods/status 34.1%: the loop is 68% of the apiserver's requests; with the six nodes'
//     normal traffic they send 78%), and the per-node rates measured after the fix (task-710).
// (2) botgw.deliveries on lumo-prod: autovacuum 15:32:33 and autoanalyze 15:32:40 (pg_stat_user_tables), oldest pending
//     15:33:01, 18,094 waiting at 15:50 and 26,314 at 15:56:11, Due running ~a minute (tamar, dana), ANALYZE at 15:55:59.
// (3) wabridge-dc5bfb87c-wgpgm on lumo-prod: OOMKilled 7 times on a 256Mi limit, the last at 15:51:07, CrashLoopBackOff (rotem).

const T = (hms: string) => Date.parse(`2026-10-26T${hms}Z`);
const S = (hms: string) => Math.round(T(hms) / 1000);
const MIN = 60_000;

/** Collector output (the format CLUSTER_SCRIPT prints), built from the parts a case needs. */
function out(o: { ts: number; api?: string; nodes?: { name: string; v: string; ip: string; req?: number; cpu?: number[]; bench?: number }[];
  pods?: string[]; apiTotal?: number; pg?: Record<string, Record<string, string[]>> }): string {
  const s: string[] = [`@@ now\n${Math.round(o.ts / 1000)}`];
  if (o.api) s.push(`@@ version\n${JSON.stringify({ serverVersion: { major: '1', minor: o.api.split('.')[1], gitVersion: o.api } })}`);
  // A cluster always has a node; with none the round is unknown (kubectl didn't answer).
  const nodes = o.nodes?.length ? o.nodes : [{ name: 'vmi1000003', v: 'v1.34.3+k3s1', ip: '203.0.113.15' }];
  s.push(`@@ nodes\n${nodes.map((n) => `${n.name}\t${n.v}\t${n.ip}`).join('\n')}`);
  s.push(`@@ pods\n${(o.pods ?? []).join('\n')}`);
  if (o.apiTotal != null) s.push(`@@ apiserver\n${o.apiTotal}`);
  for (const n of o.nodes ?? []) s.push(`@@ node ${n.name}\nrequests ${n.req ?? ''}\n${n.cpu ? `cpu  ${n.cpu.join(' ')}\n` : ''}${n.bench != null ? `bench 1000.00 ${(1000 + n.bench).toFixed(2)}` : ''}`);
  for (const [c, dbs] of Object.entries(o.pg ?? {})) s.push(`@@ pg ${c}\n${Object.entries(dbs).map(([db, l]) => `@@@ ${db}\n${l.join('\n')}`).join('\n')}`);
  return `\n${s.join('\n')}\n`;
}
const snap = (text: string) => parseSnapshot(text, 0)!;

async function rootEnv(failingHttp: string[] = []) {
  const env = await makeEnv();
  const w = env.hq.probes.roots;
  w.failingHttp = () => failingHttp;
  const to = (who: string) => env.hq.store.db.prepare('SELECT kind, priority, urgency, body FROM messages WHERE to_identity = ? ORDER BY rowid').all(who) as { kind: string; priority: string; urgency: string; body: string }[];
  const open = () => (env.hq.store.db.prepare('SELECT key, rounds FROM root_findings ORDER BY key').all() as { key: string; rounds: number }[]).map((r) => r.key);
  return { env, w, to, open };
}

// ---------- (1) kubelet 1.34 against apiserver 1.33: the PATCH loop ----------

// The shared cluster on 26/10 (task-697's table): name, kubelet, IP. Requests a minute after the fix (measured 16:07 UTC).
const OLD = [
  ['srv1000002', 'v1.33.6+k3s1', '203.0.113.13', 151], ['vmi1000001', 'v1.33.6+k3s1', '203.0.113.32', 122],
  ['vmi1000002', 'v1.34.4+k3s1', '203.0.113.33', 139], ['vmi1000004', 'v1.33.6+k3s1', '203.0.113.20', 116],
  ['vmi1000005', 'v1.33.6+k3s1', '203.0.113.21', 120], ['vmi1000006', 'v1.33.6+k3s1', '203.0.113.37', 116],
  ['vmi1000007', 'v1.33.6+k3s1', '203.0.113.36', 124], ['vmi1000008', 'v1.33.6+k3s1', '203.0.113.22', 124],
  ['vmi1000009', 'v1.34.3+k3s1', '203.0.113.30', 57], ['vmi1000010', 'v1.34.3+k3s1', '203.0.113.38', 125],
  ['vmi1000011', 'v1.34.3+k3s1', '203.0.113.31', 124], ['vmi1000012', 'v1.34.4+k3s1', '203.0.113.35', 127],
  ['vmi1000013', 'v1.34.4+k3s1', '203.0.113.23', 126], ['vmi1000015', 'v1.33.6+k3s1', '203.0.113.28', 128],
  ['vmi1000016', 'v1.33.6+k3s1', '203.0.113.34', 59], ['vmi1000017', 'v1.33.6+k3s1', '203.0.113.24', 116],
  ['vmi1000018', 'v1.33.6+k3s1', '203.0.113.25', 128], ['vmi1000019', 'v1.33.6+k3s1', '203.0.113.26', 115],
] as const;
// task-697: PATCH pods/status a minute per 1.34 node; each PATCH comes after a GET of the pod (the loop is GET + PATCH).
const PATCH_PER_MIN: Record<string, number> = { vmi1000011: 489, vmi1000013: 462, vmi1000010: 470, vmi1000012: 452, vmi1000002: 411, vmi1000009: 169 };
const API_AFTER_FIX = 2283; // apiserver requests a minute after the fix, WATCH/CONNECT excluded (16:07 UTC)

/** The shared cluster, a round every 5 minutes from 14:00: counters (kubelet requests, apiserver total, the master's /proc/stat) add up.
 *  `loop`: the 1.34 kubelets still loop. `steal`: the master's steal that round (18.1% during the loop, 7.2% after: task-697). */
class OldCluster {
  private m = -5;
  private req = new Map<string, number>();
  private api = 0;
  private cpu = [0, 0, 0, 0, 0, 0, 0, 0];
  next(loop: boolean, steal = loop ? 18.1 : 7.2, fixed = !loop): string {
    this.m += 5;
    const mins = this.m === 0 ? 0 : 5;
    for (const [n, , , base] of OLD) this.req.set(n, (this.req.get(n) ?? 1e6) + mins * (base + (loop ? 2 * (PATCH_PER_MIN[n] ?? 0) : 0)));
    this.api += mins * (API_AFTER_FIX + (loop ? 2 * Object.values(PATCH_PER_MIN).reduce((x, y) => x + y, 0) : 0));
    const ticks = 8 * 100 * 60 * mins; // 8 cores, 100 ticks a second
    this.cpu = this.cpu.map((v, i) => v + Math.round(ticks * ([0.17, 0, 0, 0.83 - steal / 100, 0, 0, 0, steal / 100][i]!)));
    return out({ ts: T('14:00:00') + this.m * MIN, api: 'v1.33.6+k3s1', apiTotal: 5e7 + this.api,
      nodes: OLD.map(([name, v, ip]) => ({ name, v: fixed ? 'v1.33.6+k3s1' : v, ip, req: this.req.get(name), cpu: name === 'srv1000002' ? this.cpu : undefined })) });
  }
}

test('(1) kubelet 1.34 vs apiserver 1.33: the six nodes flood the apiserver; רותם hears of it in the second round, the owner after an hour with no symptom', async () => {
  const { env, w, to, open } = await rootEnv();
  try {
    const c = new OldCluster();
    w.observe('tiki-bot-go/cluster', snap(c.next(true)));
    assert.deepEqual(open(), ['kubelet-skew'], 'first round: no deltas yet, only the versions');
    w.observe('tiki-bot-go/cluster', snap(c.next(true)));
    assert.deepEqual(open(), ['api-source', 'kubelet-skew']);
    assert.equal(to('rotem').length, 1, 'skew lasted two rounds');
    assert.equal(to('rotem')[0]!.priority, 'now');
    assert.match(to('rotem')[0]!.body, /version skew: 6 kubelets מחוץ לטווח הנתמך מול apiserver v1\.33\.6\+k3s1/);
    w.observe('tiki-bot-go/cluster', snap(c.next(true)));
    const m = to('rotem').at(-1)!;
    assert.equal(m.kind, 'probe_anomaly');
    assert.equal(m.priority, 'now');
    assert.match(m.body, /6 נודים מציפים את ה-apiserver: 5604 בקשות לדקה, 78% מכל הבקשות \(7189 לדקה\)\. נוד רגיל שולח 126 לדקה/);
    assert.match(m.body, /vmi1000011: 1102 לדקה, kubelet v1\.34\.3\+k3s1 \(חדש מה-apiserver v1\.33\.6\+k3s1\)/);
    assert.match(m.body, /vmi1000009: 395 לדקה/);
    assert.doesNotMatch(m.body, /vmi1000001:/, 'a 1.33 node is not a source');
    // The master's steal that day was 18.1% (task-697): under the threshold, so no symptom. The loop is the cluster's own root and
    // its sources send more than half the requests: an hour from the first round (14:00) it reaches the owner anyway (rotem).
    for (let i = 0; i < 9; i++) w.observe('tiki-bot-go/cluster', snap(c.next(true))); // 14:15–14:55
    assert.equal(to('owner').length, 0);
    assert.ok(!open().some((k) => k.startsWith('steal/')));
    w.observe('tiki-bot-go/cluster', snap(c.next(true))); // 15:00
    const o = to('owner');
    assert.equal(o.length, 1, 'skew and the flood together, one message');
    assert.equal(o[0]!.urgency, 'urgent');
    assert.match(o[0]!.body, /כבר 60 דקות:\nversion skew: 6 kubelets[\s\S]*6 נודים מציפים את ה-apiserver/);
    assert.match(o[0]!.body, /אף סימפטום לא עבר סף, אבל זה שורש של הקלאסטר עצמו שנמשך יותר מ-60 דקות/);
    w.observe('tiki-bot-go/cluster', snap(c.next(true)));
    assert.equal(to('owner').length, 1, 'once');
    // The fix (15:15–15:26): every kubelet on 1.33.6, the rates back to normal. Two clean rounds close it.
    w.observe('tiki-bot-go/cluster', snap(c.next(false)));
    w.observe('tiki-bot-go/cluster', snap(c.next(false)));
    assert.deepEqual(open(), []);
    assert.match(to('rotem').at(-1)!.body, /נסגרו בקלאסטר tiki-bot-go\/cluster[\s\S]*api-source: 6 נודים/);
    assert.match(to('owner').at(-1)!.body, /חזר לתקין בקלאסטר tiki-bot-go\/cluster:\n- api-source 6 נודים, מ-14:05:00 עד 15:05:00 UTC\n- kubelet-skew 6 נודים, מ-14:00:00/);
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  } finally { await env.cleanup(); }
});

test('(1) a flood with steal over the threshold on the master: the steal is its symptom, and it reaches the owner at 10 minutes', async () => {
  const { env, w, to } = await rootEnv();
  try {
    const c = new OldCluster();
    for (let i = 0; i < 4; i++) w.observe('c', snap(c.next(true, 30)));
    assert.equal(to('owner').length, 1);
    assert.match(to('owner')[0]!.body, /מה הוא גורם:\n- steal ב-srv1000002 \(203\.0\.113\.13\): 30% מה-CPU/);
  } finally { await env.cleanup(); }
});

test('(1) a flood of under half the requests and no skew stays with רותם', async () => {
  const { env, w, to } = await rootEnv();
  try {
    const none: History = { stats: () => ({ median: 0, n: 0 }), sum: () => 0 };
    const c = new OldCluster();
    const a = snap(c.next(true)), b = snap(c.next(true));
    b.apiTotal = a.apiTotal! + 5 * 20_000; // 5604 of 20,000 a minute: 28%
    const f = evaluate(a, b, none).findings.find((x) => x.signal === 'api-source')!;
    assert.match(f.text, /28% מכל הבקשות/);
    assert.equal(f.alone, false);
    void w; void to;
  } finally { await env.cleanup(); }
});

test('(1) the same loop with an http probe failing beside it reaches the owner at 10 minutes, once; what joins is one quiet line; recovery closes his item', async () => {
  const { env, w, to } = await rootEnv(['tiki-bot-go/entry-health']);
  try {
    const c = new OldCluster();
    for (let i = 0; i < 2; i++) w.observe('c', snap(c.next(true)));
    assert.equal(to('owner').length, 0, 'two rounds are not yet three');
    w.observe('c', snap(c.next(true))); // 14:10: the skew lasted 3 rounds, 10 minutes
    const o = to('owner');
    assert.equal(o.length, 1);
    assert.equal(o[0]!.kind, 'probe_anomaly');
    assert.equal(o[0]!.urgency, 'urgent');
    assert.match(o[0]!.body, /שורש בפרודקשן, בקלאסטר c, כבר 10 דקות:\nversion skew: 6 kubelets/);
    assert.match(o[0]!.body, /מה הוא גורם:\n- probe של http נכשל: tiki-bot-go\/entry-health/);
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'incident').length, 1);
    w.observe('c', snap(c.next(true))); // 14:15: the flood lasted too
    assert.equal(to('owner').length, 2);
    assert.equal(to('owner')[1]!.priority, 'next');
    assert.match(to('owner')[1]!.body, /באותו קלאסטר \(c\) נוסף עוד שורש שנמשך:\n6 נודים מציפים את ה-apiserver/);
    w.observe('c', snap(c.next(true)));
    assert.equal(to('owner').length, 2, 'nothing more');
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'incident').length, 1);
    w.observe('c', snap(c.next(false)));
    w.observe('c', snap(c.next(false)));
    assert.match(to('owner').at(-1)!.body, /חזר לתקין בקלאסטר c:\n- api-source[\s\S]*- kubelet-skew/);
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  } finally { await env.cleanup(); }
});

test('steal: the master at 50.5% (its average on 21/10) is a root after three rounds; 23.7% (the max of 22–26/10) is not', async () => {
  const { env, w, to, open } = await rootEnv();
  try {
    const c = new OldCluster();
    for (let i = 0; i < 3; i++) w.observe('c', snap(c.next(false, 23.7)));
    assert.deepEqual(open(), []);
    for (let i = 0; i < 3; i++) w.observe('c', snap(c.next(false, 50.5)));
    assert.deepEqual(open(), ['steal/srv1000002']);
    assert.match(to('rotem').at(-1)!.body, /steal ב-srv1000002 \(203\.0\.113\.13\): 50\.5% מה-CPU בסבב האחרון \(הסף 25%\)/);
  } finally { await env.cleanup(); }
});

// ---------- (2) autoanalyze flips the plan of botgw's Due, botgw.deliveries stops ----------

// The Due query as botgw sends it (botgw/store/postgres.go), the first 200 characters, as pg_stat_activity shows them.
const DUE = 'WITH RECURSIVE b AS ( SELECT min(bot) AS bot FROM botgw.deliveries WHERE NOT failed AND delivered_at IS NULL UNION ALL SELECT (SELECT min(bot) FROM botgw.deliveries WHERE NOT failed AND delivered_at IS NULL AND bot > b.bot) FROM b WH';
const Q = 'botgw.deliveries (delivered_at IS NULL)';
/** lumo-prod/lumo-db, db tinode, at `hms`. maint: the times pg_stat_user_tables showed that day. */
function lumoDb(at: string | number, o: { depth: number; oldest?: string; due?: number; analyze?: string }) {
  const ts = typeof at === 'number' ? at : T(at);
  return out({ ts, nodes: [], pg: { 'lumo-prod/lumo-db': { tinode: [
    ...(o.due != null ? [`act\t${'a'.repeat(32)}\t${o.due}\t${DUE}`] : []),
    ...(ts >= T('15:32:40') ? [`maint\tbotgw.deliveries\t${S(o.analyze ?? '15:32:40')}\t${S('15:32:33')}`] : []),
    `queue\t${Q}\t${o.depth}\t${o.oldest ? Math.round((ts - T(o.oldest)) / 1000) : 2}`,
    `queue\tpublic.reports (handledat IS NULL)\t0\t0`,
  ] } } });
}

test('(2) autoanalyze then a Due running a minute is a root, the stalled queue its symptom: רותם at 15:40, the owner at 15:45, closed after the ANALYZE', async () => {
  const { env, w, to, open } = await rootEnv();
  try {
    // A normal hour before: the queue near 0, the oldest ~2 seconds (tamar: "ביום רגיל התור קרוב ל-0", 2s from creation).
    for (let i = 0; i <= 12; i++) w.observe('lumo/cluster', snap(lumoDb(T('14:30:00') + i * 5 * MIN, { depth: 3 })));
    assert.deepEqual(open(), []);
    // 15:35–15:50: Due runs ~a minute each call; the oldest stays 15:33:01; depth grows (18,094 at 15:50, measured).
    w.observe('lumo/cluster', snap(lumoDb('15:35:00', { depth: 2100, oldest: '15:33:01', due: 52 })));
    // The oldest is 2 minutes old, not yet a stall; but 2,100 waiting against ~3 is the queue filling: a symptom already.
    assert.deepEqual(open(), [`pg-slow/lumo-prod/lumo-db/tinode/${'a'.repeat(32)}`, `queue-depth/lumo-prod/lumo-db/tinode/${Q}`]);
    w.observe('lumo/cluster', snap(lumoDb('15:40:00', { depth: 7400, oldest: '15:33:01', due: 47 })));
    const r = to('rotem').at(-1)!;
    assert.equal(r.priority, 'now');
    assert.match(r.body, /שאילתה ב-lumo-prod\/lumo-db\/tinode רצה 47 שניות \(הסף 10\): WITH RECURSIVE b AS/);
    assert.match(r.body, /ממש לפני: analyze על botgw\.deliveries ב-15:32:40 UTC, 7 דקות לפני; vacuum על botgw\.deliveries ב-15:32:33 UTC, 7 דקות לפני\. כנראה התוכנית של השאילתה התחלפה/);
    w.observe('lumo/cluster', snap(lumoDb('15:45:00', { depth: 12700, oldest: '15:33:01', due: 58 })));
    assert.ok(open().includes(`queue/lumo-prod/lumo-db/tinode/${Q}`));
    const o = to('owner');
    assert.equal(o.length, 1, 'root three rounds, 10 minutes, a symptom beside it');
    assert.match(o[0]!.body, /שורש בפרודקשן, בקלאסטר lumo\/cluster, כבר 10 דקות/);
    assert.match(o[0]!.body, /מה הוא גורם:\n- התור botgw\.deliveries \(delivered_at IS NULL\) ב-lumo-prod\/lumo-db\/tinode עומד: 12,700 ממתינים, הישן ביותר מ-15:33:01 UTC \(12 דקות\)\. בדרך כלל הישן ביותר בן 2 שניות/);
    w.observe('lumo/cluster', snap(lumoDb('15:50:00', { depth: 18094, oldest: '15:33:01', due: 55 })));
    w.observe('lumo/cluster', snap(lumoDb('15:55:00', { depth: 25100, oldest: '15:33:01', due: 49 })));
    assert.equal(to('owner').length, 1);
    // 15:55:59 ANALYZE (GO): 15:59:26 the queue is 0, no long Due (tamar).
    w.observe('lumo/cluster', snap(lumoDb('16:00:00', { depth: 0, analyze: '15:55:59' })));
    w.observe('lumo/cluster', snap(lumoDb('16:05:00', { depth: 0, analyze: '15:55:59' })));
    assert.deepEqual(open(), []);
    assert.match(to('owner').at(-1)!.body, /חזר לתקין בקלאסטר lumo\/cluster:\n- pg-slow lumo-prod\/lumo-db\/tinode/);
    assert.match(to('rotem').at(-1)!.body, /queue-stall: lumo-prod\/lumo-db\/tinode botgw\.deliveries/);
  } finally { await env.cleanup(); }
});

test('queues: a queue whose oldest is always old (reports nobody handles) is its own baseline, never a stall; no baseline yet, no alert', () => {
  const h = (median: number, n: number): History => ({ stats: () => ({ median, n }), sum: () => 0 });
  const s = snap(out({ ts: T('16:00:00'), pg: { 'lumo-prod/lumo-db': { tinode: ['queue\tpublic.reports (handledat IS NULL)\t3\t887953'] } } }));
  assert.equal(evaluate(null, s, h(880_000, 288)).findings.length, 0);
  assert.equal(evaluate(null, s, h(0, 5)).findings.length, 0, 'an hour of samples is needed first');
  assert.equal(evaluate(null, s, h(2, 288)).findings[0]!.signal, 'queue-stall');
});

test('pg: a query that is slow every day (a report) is not a root; pg_stat_statements: a mean 5× its median after an analyze is', () => {
  const s = snap(out({ ts: T('16:00:00'), pg: { 'p/db': { app: [`act\th1\t40\tSELECT count(*) FROM public.messages`] } } }));
  const chronic: History = { stats: () => ({ median: 0, n: 0 }), sum: (k) => k.startsWith('act:') ? 20 : 0 };
  assert.equal(evaluate(null, s, chronic).findings.length, 0);
  const fresh: History = { stats: () => ({ median: 0, n: 0 }), sum: () => 0 };
  assert.equal(evaluate(null, s, fresh).findings[0]!.signal, 'pg-slow');
  // No cluster of ours has pg_stat_statements loaded (26/10): this part is ready for when it is.
  const st = (ts: number, calls: number, total: number) => snap(out({ ts, pg: { 'p/db': { app: [
    `maint\tbotgw.deliveries\t${S('15:32:40')}\t0`, `stmt\t-412\t${calls}\t${total}\tSELECT * FROM botgw.deliveries WHERE bot = $1`] } } }));
  const base: History = { stats: () => ({ median: 4, n: 288 }), sum: () => 0 };
  const jump = evaluate(st(T('15:35:00'), 1000, 4000), st(T('15:40:00'), 1100, 4000 + 100 * 900), base);
  assert.equal(jump.findings[0]!.signal, 'pg-stmt');
  assert.match(jump.findings[0]!.text, /קפץ ל-900ms מול 4ms ביום האחרון \(100 קריאות בסבב\)/);
  assert.match(jump.findings[0]!.text, /analyze על botgw\.deliveries ב-15:32:40 UTC, 7 דקות לפני/);
  assert.equal(evaluate(st(T('15:35:00'), 1000, 4000), st(T('15:40:00'), 1100, 4000 + 100 * 6), base).findings.length, 0);
});

// ---------- (3) wabridge killed on memory in a loop ----------

const wabridge = (restarts: number, last: string, waiting = 'CrashLoopBackOff') =>
  `lumo-prod\twabridge-dc5bfb87c-wgpgm\tvmi1000003\tReplicaSet\t2026-10-25T12:02:00Z\tRunning\twabridge,${restarts},${restarts ? `${waiting},OOMKilled,2026-10-26T${last}Z` : ',,'};\twabridge=256Mi;`;
// Real rows from the collector that day (task-710, 16:05 UTC): tinode-0's one restart at the fence, and the shared cluster's chronic loops.
const TINODE = 'lumo-prod\tlumo-tinode-0\tvmi1000003\tStatefulSet\t2026-10-26T15:00:21Z\tRunning\ttinode,1,,Error,2026-10-26T15:40:39Z;\ttinode=2Gi;';
const NOISE = [
  'default\twhatsapp-ai-5c4577cd5-4z96d\tvmi1000012\tReplicaSet\t2026-10-18T17:01:51Z\tRunning\twhatsapp-ai,2214,CrashLoopBackOff,Error,2026-10-26T16:03:28Z;\twhatsapp-ai=512Mi;',
  'default\tlegacy-restarter-74d5cc5956-258tp\tvmi1000002\tReplicaSet\t2026-10-19T12:32:47Z\tRunning\tcontainer-0,2005,CrashLoopBackOff,Error,2026-10-26T15:59:52Z;\tcontainer-0=;',
];

test('(3) wabridge OOMKilled in a loop on 256Mi: a root with its CrashLoop beside it; רותם at 15:50, the owner at 15:55; the chronic loops and tinode stay quiet', async () => {
  const { env, w, to, open } = await rootEnv();
  try {
    const at = (hms: string, rows: string[]) => w.observe('lumo/cluster', snap(out({ ts: T(hms), pods: [TINODE, ...NOISE, ...rows] })));
    at('15:40:00', [wabridge(0, '')]);
    assert.deepEqual(open(), [], 'tinode restarted once on the fence; the chronic loops are noise');
    at('15:45:00', [wabridge(4, '15:44:31')]);
    assert.deepEqual(open(), ['crash/lumo-prod/wabridge/wabridge', 'oom/lumo-prod/wabridge/wabridge']);
    at('15:50:00', [wabridge(6, '15:48:12')]);
    const r = to('rotem').at(-1)!;
    assert.equal(r.priority, 'now');
    assert.match(r.body, /lumo-prod\/wabridge-dc5bfb87c-wgpgm \(container wabridge, על vmi1000003\) נהרג על זיכרון בלולאה: OOMKilled, 6 restarts, 6 מהם ב-30 הדקות האחרונות, המגבלה 256Mi, ההריגה האחרונה ב-15:48:12 UTC/);
    assert.match(r.body, /סימפטום \(crashloop\)/);
    at('15:55:00', [wabridge(7, '15:51:07')]);
    const o = to('owner');
    assert.equal(o.length, 1);
    assert.match(o[0]!.body, /כבר 10 דקות:\nlumo-prod\/wabridge-dc5bfb87c-wgpgm[\s\S]*המגבלה 256Mi, ההריגה האחרונה ב-15:51:07 UTC/);
    assert.match(o[0]!.body, /מה הוא גורם:\n- lumo-prod\/wabridge-dc5bfb87c-wgpgm \(container wabridge, על vmi1000003\) ב-CrashLoopBackOff: 7 restarts, הסיבה האחרונה OOMKilled/);
    assert.doesNotMatch(o[0]!.body, /whatsapp-ai|legacy|tinode/);
    // 15:53:39 the new pod with 1Gi (GO): a new pod name, the same workload, no restarts.
    const fixed = 'lumo-prod\twabridge-9bb5dbf7d-jq7j2\tvmi1000003\tReplicaSet\t2026-10-26T15:53:39Z\tRunning\twabridge,0,,,;\twabridge=1Gi;';
    at('16:00:00', [fixed]);
    at('16:05:00', [fixed]);
    assert.deepEqual(open(), []);
    assert.match(to('owner').at(-1)!.body, /חזר לתקין בקלאסטר lumo\/cluster:\n- oom-loop lumo-prod\/wabridge/);
  } finally { await env.cleanup(); }
});

test('OOM/CrashLoop: `ignore` in the charter silences a workload or a namespace; one OOM is not a loop', () => {
  const none: History = { stats: () => ({ median: 0, n: 0 }), sum: () => 0 };
  const s = snap(out({ ts: T('15:50:00'), pods: [wabridge(6, '15:48:12')] }));
  assert.equal(evaluate(null, s, none).findings.length, 2);
  assert.equal(evaluate(null, s, none, ['lumo-prod/wabridge']).findings.length, 0);
  assert.equal(evaluate(null, s, none, ['lumo-prod']).findings.length, 0);
  const once = snap(out({ ts: T('15:50:00'), pods: [wabridge(1, '15:48:12', '')] }));
  assert.equal(evaluate(null, once, none).findings.length, 0);
});

// ---------- the rest ----------

test('the real collector output of 26/10 (lumo cluster, 16:05 UTC) parses: nodes, CPU, the loop, every pod, queues; nothing wrong in it', () => {
  const s = parseSnapshot(readFileSync(join(import.meta.dirname, 'fixtures', 'root-signals', 'lumo-26-10.txt'), 'utf8'), 0)!;
  assert.equal(s.apiserver, 'v1.34.3+k3s1');
  assert.deepEqual(s.nodes.map((n) => [n.name, n.kubelet, n.ip]), [['vmi1000003', 'v1.34.3+k3s1', '203.0.113.15'], ['vmi1000014', 'v1.34.3+k3s1', '203.0.113.29'], ['vmi1000020', 'v1.34.3+k3s1', '203.0.113.27']]);
  assert.equal(s.nodes[0]!.requests, 533496);
  assert.equal(s.nodes[0]!.cpu!.length, 10);
  assert.equal(s.nodes[0]!.benchS, 2.37);
  assert.ok(s.containers.some((c) => c.pod === 'lumo-tinode-0' && c.lastReason === 'Error' && c.restarts === 1 && c.memLimit === '2Gi'));
  assert.deepEqual(s.pg.map((d) => `${d.cluster}/${d.db}`), ['lumo-prod/lumo-db/app', 'lumo-prod/lumo-db/tinode', 'lumobot/lumobot-db/lumobot']);
  assert.deepEqual(s.pg[1]!.queues.map((q) => q.name), [Q, 'public.reports (handledat IS NULL)']);
  assert.ok(s.pg[1]!.maint.some((m) => m.table === 'botgw.deliveries'));
  assert.equal(evaluate(null, s, { stats: () => ({ median: 0, n: 0 }), sum: () => 0 }).findings.length, 0);
  assert.equal(parseSnapshot('Permission denied (publickey)', 0), null, 'not collector output: unknown');
});

test('skew: kubelet newer than the apiserver, or more than 3 minors older; helpers', () => {
  const none: History = { stats: () => ({ median: 0, n: 0 }), sum: () => 0 };
  const s = (v: string) => evaluate(null, snap(out({ ts: 0, api: 'v1.33.6+k3s1', nodes: [{ name: 'n', v, ip: '1' }] })), none).findings.map((f) => f.signal);
  assert.deepEqual(s('v1.34.3+k3s1'), ['kubelet-skew']);
  assert.deepEqual(s('v1.30.1+k3s1'), [], '3 older is supported');
  assert.deepEqual(s('v1.29.1+k3s1'), ['kubelet-skew']);
  assert.equal(workload('wabridge-dc5bfb87c-wgpgm'), 'wabridge');
  assert.equal(workload('node-exporter-qxjps'), 'node-exporter');
  assert.equal(workload('lumo-tinode-0'), 'lumo-tinode-0');
  assert.deepEqual(queryTables(DUE), ['botgw.deliveries']);
  assert.ok(isSshTarget('root@203.0.113.13'));
  assert.ok(!isSshTarget('-oProxyCommand=x'));
  assert.ok(!/\b(delete|drop|insert|update|alter|create|truncate|apply|patch|scale|cordon|drain)\b/i.test(CLUSTER_SCRIPT.replace(/default_transaction_read_only|pg_stat_user_tables|last_autovacuum|autovacuum|lastState|last_vacuum|last_autoanalyze|last_analyze|rest_client_requests_total/g, '')),
    'the collector only reads');
});

test('a node getting less CPU: the shell loop at more than twice its median, three rounds', async () => {
  const { env, w, open, to } = await rootEnv();
  try {
    const at = (m: number, bench: number) => w.observe('c', snap(out({ ts: T('10:00:00') + m * MIN, nodes: [{ name: 'vmi1', v: 'v1.33.6', ip: '10.0.0.1', bench }] })));
    for (let i = 0; i < 12; i++) at(i * 5, 0.3);
    at(60, 0.5);
    assert.deepEqual(open(), []);
    for (const m of [65, 70, 75]) at(m, 0.9);
    assert.deepEqual(open(), ['cpu/vmi1']);
    assert.match(to('rotem').at(-1)!.body, /vmi1 \(10\.0\.0\.1\) מקבלת כ-33% מה-CPU שהיא מקבלת בדרך כלל: לולאה קבועה רצה 0\.9s מול חציון של 0\.3s/);
  } finally { await env.cleanup(); }
});

test('charter: a `cluster:` probe runs a round over ssh every 5m by default; an ssh failure is unknown and changes nothing', async () => {
  const md = '# lumo\n\n```yaml\nprobes:\n  - {id: cluster, cluster: root@203.0.113.15, identity: ~/.ssh/lumo-cluster_ed25519, ignore: [default/whatsapp-ai]}\n  - {id: bad, cluster: "-oProxyCommand=x"}\n```\n';
  const [p, bad] = parseCharterProbes('lumo', md);
  assert.equal(p!.kind, 'cluster');
  assert.equal(p!.everyMs, 300_000);
  assert.equal(p!.timeoutMs, 180_000);
  assert.deepEqual(p!.cluster!.ignore, ['default/whatsapp-ai']);
  assert.match(p!.cluster!.identityFile!, /\/\.ssh\/lumo-cluster_ed25519$/);
  assert.equal(bad!.kind, 'unsupported');
  const env = await makeEnv({ projects: { lumo: md } });
  try {
    const { hq } = env;
    const calls: string[] = [];
    let fail = false;
    hq.probes.roots.collect = async (c) => { calls.push(c.ssh); if (fail) throw new Error('ssh exit 255'); return out({ ts: hq.store.now(), pods: [wabridge(6, '15:48:12')] }); };
    await hq.probes.tick();
    await until(() => (hq.store.db.prepare('SELECT COUNT(*) n FROM root_findings').get() as { n: number }).n === 2);
    assert.deepEqual(calls, ['root@203.0.113.15']);
    await hq.probes.tick();
    assert.equal(calls.length, 1, 'not due again within 5 minutes');
    fail = true;
    env.clock.advance(5 * MIN);
    await hq.probes.tick();
    await until(() => (hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'roots.unknown'`).get() as { n: number }).n === 1);
    const rows = hq.store.db.prepare('SELECT rounds, misses FROM root_findings').all() as { rounds: number; misses: number }[];
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ rounds: 1, misses: 0 }, { rounds: 1, misses: 0 }], 'unknown: nothing moved');
  } finally { await env.cleanup(); }
});

// ---------- the review of #325 ----------

test('blind rounds close nothing: the apiserver down (no nodes), the primary not answering, pods failing; three in a row tell רותם once', async () => {
  const { env, w, to, open } = await rootEnv();
  try {
    const at = (hms: string, o: { depth: number; oldest?: string; due?: number }) => w.observe('lumo/cluster', snap(lumoDb(hms, o)));
    for (let i = 0; i <= 12; i++) w.observe('lumo/cluster', snap(lumoDb(T('14:30:00') + i * 5 * MIN, { depth: 3 })));
    at('15:35:00', { depth: 2100, oldest: '15:33:01', due: 52 });
    at('15:40:00', { depth: 7400, oldest: '15:33:01', due: 47 });
    at('15:45:00', { depth: 12700, oldest: '15:33:01', due: 58 });
    const before = open();
    assert.ok(before.includes(`queue/lumo-prod/lumo-db/tinode/${Q}`) && before.some((k) => k.startsWith('pg-slow/')));
    // The primary didn't answer `kubectl exec` (60s): the pg section is `!failed`. Twice: nothing closes.
    const failed = out({ ts: T('15:50:00'), pods: [TINODE] }).replace(/$/, '\n@@ pg lumo-prod/lumo-db\n!failed\n');
    w.observe('lumo/cluster', snap(failed));
    w.observe('lumo/cluster', snap(failed.replace(`${S('15:50:00')}`, `${S('15:55:00')}`)));
    assert.deepEqual(open(), before);
    assert.ok(!to('owner').some((m) => /חזר לתקין/.test(m.body)));
    // The apiserver down: no nodes. parseSnapshot says unknown, and round() counts it.
    assert.equal(parseSnapshot('\n@@ now\n1\n@@ version\n\n@@ nodes\n\n@@ pods\n!failed\n@@ apiserver\n\n', 0), null);
    w.collect = async () => '\n@@ now\n1\n@@ version\n\n@@ nodes\n\n@@ pods\n!failed\n@@ apiserver\n\n';
    for (let i = 0; i < 4; i++) assert.equal(await w.round('lumo/cluster', { ssh: 'root@203.0.113.15', identityFile: null, ignore: [] }, 1000), 'unknown');
    assert.deepEqual(open(), before);
    const blind = to('rotem').filter((m) => /עיוורים/.test(m.body));
    assert.equal(blind.length, 1, 'once, at the third');
    assert.match(blind[0]!.body, /אותות השורש של lumo\/cluster עיוורים: 3 סבבים ברצף בלי תשובה \(root@203\.0\.113\.15\)/);
    w.collect = async () => lumoDb('16:10:00', { depth: 0 });
    await w.round('lumo/cluster', { ssh: 'root@203.0.113.15', identityFile: null, ignore: [] }, 1000);
    assert.ok(to('rotem').some((m) => /חזרו לראות, אחרי 4 סבבים/.test(m.body)));
  } finally { await env.cleanup(); }
});

test('a new OOM loop in an old pod stays a loop past 20 restarts; one that was looping when first seen is the noise; -dev is not production', async () => {
  const { env, w, open } = await rootEnv();
  try {
    const row = (restarts: number, last: string) => `lumo-prod\twabridge-dc5bfb87c-wgpgm\tvmi1000003\tReplicaSet\t2026-10-25T12:02:00Z\tRunning\twabridge,${restarts},CrashLoopBackOff,OOMKilled,2026-10-26T${last}Z;\twabridge=256Mi;`;
    const dev = 'lumo-dev\tlumo-tinode-0\tvmi1000003\tStatefulSet\t2026-10-26T15:30:00Z\tRunning\ttinode,5,CrashLoopBackOff,Error,2026-10-26T15:58:00Z;\ttinode=1Gi;';
    w.observe('c', snap(out({ ts: T('16:00:00'), pods: [row(4, '15:59:00'), dev] })));
    assert.deepEqual(open(), ['crash/lumo-prod/wabridge/wabridge', 'oom/lumo-prod/wabridge/wabridge']);
    w.observe('c', snap(out({ ts: T('17:20:00'), pods: [row(19, '17:19:00'), dev] })));
    w.observe('c', snap(out({ ts: T('17:25:00'), pods: [row(20, '17:24:00'), dev] })));
    w.observe('c', snap(out({ ts: T('17:30:00'), pods: [row(21, '17:29:00'), dev] })));
    assert.deepEqual(open(), ['crash/lumo-prod/wabridge/wabridge', 'oom/lumo-prod/wabridge/wabridge'], 'still open: not noise');
  } finally { await env.cleanup(); }
});

test('the owner\'s "back to normal" names every root of his incident, also one that closed before the last', async () => {
  const { env, w, to } = await rootEnv(['tiki-bot-go/entry-health']);
  try {
    const c = new OldCluster();
    for (let i = 0; i < 4; i++) w.observe('c', snap(c.next(true))); // skew 14:10, the flood joins 14:15
    assert.equal(to('owner').length, 2);
    // The flood stops (kubelets still 1.34): the flood closes first, the skew stays.
    w.observe('c', snap(c.next(false, 7.2, false)));
    w.observe('c', snap(c.next(false, 7.2, false)));
    assert.ok(!to('owner').some((m) => /חזר לתקין/.test(m.body)), 'the skew is still open');
    w.observe('c', snap(c.next(false, 7.2, true)));
    w.observe('c', snap(c.next(false, 7.2, true)));
    const done = to('owner').at(-1)!.body;
    assert.match(done, /חזר לתקין בקלאסטר c:\n- api-source 6 נודים[\s\S]*\n- kubelet-skew 6 נודים/);
  } finally { await env.cleanup(); }
});

test('queue depth: a queue filling to 5× its usual depth, over 2,000, with a young oldest is a symptom too', () => {
  const h: History = { stats: (k) => k.startsWith('queue-depth:') ? { median: 40, n: 288 } : { median: 2, n: 288 }, sum: () => 0 };
  const at = (depth: number) => evaluate(null, snap(out({ ts: T('16:00:00'), pg: { 'p/db': { app: [`queue\t${Q}\t${depth}\t3`] } } })), h).findings;
  assert.deepEqual(at(1500).map((f) => f.key), []);
  const f = at(26314);
  assert.deepEqual(f.map((x) => x.key), [`queue-depth/p/db/app/${Q}`]);
  assert.match(f[0]!.text, /מתמלא: 26,314 ממתינים, בדרך כלל 40/);
});
