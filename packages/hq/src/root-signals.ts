// Root signals (memory/company/monitoring/root-signals-spec.md, 26/10): the layer under the services, read-only, the same for every
// service with nothing declared per service. A `cluster:` probe in a charter names a k3s master; every round one ssh runs
// CLUSTER_SCRIPT there, which only reads: kubectl get (nodes, pods, /metrics, the kubelets' /metrics), `cat /proc/stat` and a tiny
// shell loop inside a DaemonSet pod on each node, and psql with default_transaction_read_only in the primary of every CNPG cluster.
// Findings: kubelet newer than the apiserver, one node flooding the apiserver, steal, a node getting less CPU than it used to (with steal), a
// container killed on memory in a loop, a container crash-looping, a query running long (and the analyze/vacuum just before it),
// a statement whose mean jumped (when pg_stat_statements is there), a queue whose oldest row is far older than it usually is.
// A finding that lasts reaches רותם; a root (not a symptom) that lasts OWNER_ROUNDS reaches the owner, with the symptoms beside it.
// The cluster's own roots (version skew, a flood of over half the apiserver's requests) reach him after ROOT_ALONE_MS even with none.
import { OWNER, pre } from '@company/shared';
import { runSsh, type SshRun } from './nodes.ts';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';
import type { Inbox } from './inbox.ts';

export interface ClusterSpec { ssh: string; identityFile: string | null; ignore: string[] }

/** `root@host` or `host`: never something ssh could read as an option. */
export const isSshTarget = (s: string): boolean => /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(s);

/** The collector. Everything in it only reads; `-dev` namespaces are skipped (not production). Sections start with `@@ <name>`. */
export const CLUSTER_SCRIPT = String.raw`set +e
K=kubectl; command -v kubectl >/dev/null 2>&1 || K="k3s kubectl"
out() { printf '\n@@ %s\n%s\n' "$1" "$2"; }
out now "$(date +%s)"
out version "$($K version -o json 2>/dev/null | tr -d '\n ')"
NODES=$($K get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.kubeletVersion}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' 2>/dev/null)
out nodes "$NODES"
PODS=$($K get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.nodeName}{"\t"}{.metadata.ownerReferences[0].kind}{"\t"}{.status.startTime}{"\t"}{.status.phase}{"\t"}{range .status.containerStatuses[*]}{.name}{","}{.restartCount}{","}{.state.waiting.reason}{","}{.lastState.terminated.reason}{","}{.lastState.terminated.finishedAt}{";"}{end}{"\t"}{range .spec.containers[*]}{.name}{"="}{.resources.limits.memory}{";"}{end}{"\n"}{end}' 2>/dev/null)
[ -n "$PODS" ] || PODS='!failed'
out pods "$PODS"
out apiserver "$($K get --raw /metrics 2>/dev/null | grep '^apiserver_request_total{' | grep -v 'verb="WATCH"' | grep -v 'verb="CONNECT"' | awk '{s+=$NF} END {if (NR) printf "%.0f", s}')"
T=$(mktemp -d)
for n in $(printf '%s\n' "$NODES" | cut -f1); do
  ( m=$($K get --raw "/api/v1/nodes/$n/proxy/metrics" --request-timeout=10s 2>/dev/null | grep '^rest_client_requests_total{' | awk '{s+=$NF} END {if (NR) printf "%.0f", s}')
    p=$(printf '%s\n' "$PODS" | awk -F'\t' -v n="$n" '$3==n && $4=="DaemonSet" && $6=="Running" {print $1" "$2}' | head -3)
    c=""
    while read -r ns pod; do
      [ -n "$pod" ] || continue
      c=$($K -n "$ns" exec "$pod" --request-timeout=15s -- sh -c 'head -1 /proc/stat; read a b < /proc/uptime; i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; read c d < /proc/uptime; echo "bench $a $c"' 2>/dev/null) && [ -n "$c" ] && break
      c=""
    done <<EOF
$p
EOF
    printf 'requests %s\n%s\n' "$m" "$c" > "$T/$n" ) &
done
wait
for f in "$T"/*; do [ -f "$f" ] && out "node $(basename "$f")" "$(cat "$f")"; done
rm -rf "$T"
PG=$(cat <<'PGEOF'
for db in $(psql -XAtq -U postgres -c "select datname from pg_database where not datistemplate and datallowconn and datname <> 'postgres'"); do
printf '@@@ %s\n' "$db"
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' psql -XAtq -F "$(printf '\t')" -U postgres -d "$db" 2>/dev/null <<'SQL'
select 'act', md5(left(regexp_replace(query, '\s+', ' ', 'g'), 200)), extract(epoch from now() - query_start)::int, left(regexp_replace(query, '\s+', ' ', 'g'), 200)
  from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '5 seconds';
select 'maint', schemaname || '.' || relname, coalesce(extract(epoch from greatest(last_autoanalyze, last_analyze))::bigint, 0), coalesce(extract(epoch from greatest(last_autovacuum, last_vacuum))::bigint, 0)
  from pg_stat_user_tables where greatest(last_autoanalyze, last_analyze, last_autovacuum, last_vacuum) > now() - interval '2 hours';
select exists(select 1 from pg_extension where extname = 'pg_stat_statements') as has_pss \gset
\if :has_pss
select 'stmt', queryid, calls, round(total_exec_time)::bigint, left(regexp_replace(query, '\s+', ' ', 'g'), 200) from pg_stat_statements
  where dbid = (select oid from pg_database where datname = current_database()) and calls > 0 order by total_exec_time desc limit 100;
\endif
select distinct on (n.nspname, t.relname, pg_get_expr(x.indpred, x.indrelid))
  format('select %L, %L, count(*), coalesce(extract(epoch from now() - min(c)), 0)::bigint from (select %I as c from %I.%I where %s limit 100001) q',
    'queue', n.nspname || '.' || t.relname || ' (' || done.attname || ' IS NULL)', col.attname, n.nspname, t.relname, pg_get_expr(x.indpred, x.indrelid))
from pg_index x join pg_class t on t.oid = x.indrelid join pg_namespace n on n.oid = t.relnamespace
cross join lateral (select a.attname from pg_attribute a where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  and a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype) and a.attname !~* '(delet|expir|archiv)'
  and pg_get_expr(x.indpred, x.indrelid) ~* ('(^|[^a-z0-9_])' || a.attname || ' IS NULL') limit 1) done
cross join lateral (select a.attname from pg_attribute a where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  and a.atttypid in ('timestamptz'::regtype, 'timestamp'::regtype) and a.attname ~* '^(created|created_?at|enqueued_?at|queued_?at|inserted_?at)$' order by a.attnum limit 1) col
where x.indpred is not null and n.nspname not in ('pg_catalog', 'information_schema')
order by n.nspname, t.relname, pg_get_expr(x.indpred, x.indrelid) \gexec
SQL
done
PGEOF
)
$K get clusters.postgresql.cnpg.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.status.currentPrimary}{"\n"}{end}' 2>/dev/null | while IFS="$(printf '\t')" read -r ns name primary; do
  [ -n "$primary" ] || continue
  case "$ns" in *-dev) continue ;; esac
  o=$($K -n "$ns" exec "$primary" -c postgres --request-timeout=60s -- bash -c "$PG" 2>/dev/null) || o=""
  case "$o" in *'@@@ '*) ;; *) o='!failed' ;; esac
  out "pg $ns/$name" "$o"
done
`;

// ---------- the snapshot ----------

export interface NodeSample { name: string; kubelet: string; ip: string; requests: number | null; cpu: number[] | null; benchS: number | null }
export interface ContainerRow { ns: string; pod: string; node: string; owner: string; startedAt: number | null; container: string; restarts: number; waiting: string; lastReason: string; lastFinishedAt: number | null; memLimit: string }
export interface PgDb { cluster: string; db: string; active: { hash: string; secs: number; query: string }[]; maint: { table: string; analyzeAt: number; vacuumAt: number }[]; stmts: { id: string; calls: number; totalMs: number; query: string }[] | null; queues: { name: string; depth: number; ageS: number }[] }
/** `unknown`: keys of findings this snapshot could not see (a command that failed), or prefixes when they end in `/`. They are neither seen nor missing:
 *  a round in which `kubectl exec` to the primary timed out must not close the slow query that made it time out. */
export interface Snapshot { ts: number; apiserver: string | null; nodes: NodeSample[]; containers: ContainerRow[]; apiTotal: number | null; pg: PgDb[]; unknown: string[] }

const num = (s: string | undefined): number | null => { if (s == null || s.trim() === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const time = (s: string | undefined): number | null => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

/** The collector's output. null when it isn't one (no `@@ nodes`): the round is unknown, not healthy. */
export function parseSnapshot(text: string, fallbackTs: number): Snapshot | null {
  const sec = new Map<string, string>();
  const parts = text.split(/^@@ (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) sec.set(parts[i]!.trim(), (parts[i + 1] ?? '').replace(/^\n/, '').replace(/\n+$/, ''));
  // No nodes: kubectl didn't answer (the apiserver down, a timeout). The whole round is unknown, never "everything recovered".
  if (!(sec.get('nodes') ?? '').trim()) return null;
  const unknown: string[] = [];
  const nowS = num(sec.get('now'));
  let apiserver: string | null = null;
  try { apiserver = (JSON.parse(sec.get('version') || 'null') as { serverVersion?: { gitVersion?: string } } | null)?.serverVersion?.gitVersion ?? null; } catch { /* unknown */ }
  const nodes: NodeSample[] = [];
  for (const line of (sec.get('nodes') ?? '').split('\n').filter(Boolean)) {
    const [name = '', kubelet = '', ip = ''] = line.split('\t');
    const body = sec.get(`node ${name}`) ?? '';
    const req = /^requests (\d+)\s*$/m.exec(body);
    const cpu = /^cpu\s+([\d ]+)$/m.exec(body);
    const bench = /^bench (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\s*$/m.exec(body);
    nodes.push({ name, kubelet, ip: ip.split(' ')[0] ?? '', requests: req ? Number(req[1]) : null,
      cpu: cpu ? cpu[1]!.trim().split(/\s+/).map(Number) : null,
      benchS: bench ? Math.round((Number(bench[2]) - Number(bench[1])) * 100) / 100 : null });
  }
  const containers: ContainerRow[] = [];
  const pods = sec.get('pods') ?? '';
  if (!pods.trim() || pods.trim() === '!failed') unknown.push('oom/', 'crash/');
  for (const line of (pods.trim() === '!failed' ? '' : pods).split('\n').filter(Boolean)) {
    const [ns = '', pod = '', node = '', owner = '', start = '', , statuses = '', limits = ''] = line.split('\t');
    const mem = new Map(limits.split(';').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)] as const; }));
    for (const c of statuses.split(';').filter(Boolean)) {
      const [container = '', restarts = '0', waiting = '', lastReason = '', lastFinished = ''] = c.split(',');
      containers.push({ ns, pod, node, owner, startedAt: time(start), container, restarts: Number(restarts) || 0, waiting, lastReason,
        lastFinishedAt: time(lastFinished), memLimit: mem.get(container) ?? '' });
    }
  }
  const pg: PgDb[] = [];
  for (const [name, body] of sec) {
    if (!name.startsWith('pg ')) continue;
    const c = name.slice(3);
    if (!body.includes('@@@ ')) { unknown.push(`pg-slow/${c}/`, `pg-stmt/${c}/`, `queue/${c}/`, `queue-depth/${c}/`); continue; }
    const dbs = body.split(/^@@@ (.+)$/m);
    for (let i = 1; i < dbs.length; i += 2) {
      const d: PgDb = { cluster: name.slice(3), db: dbs[i]!.trim(), active: [], maint: [], stmts: null, queues: [] };
      for (const l of (dbs[i + 1] ?? '').split('\n')) {
        const f = l.split('\t');
        if (f[0] === 'act' && f.length >= 4) d.active.push({ hash: f[1]!, secs: Number(f[2]) || 0, query: f.slice(3).join('\t') });
        else if (f[0] === 'maint' && f.length >= 4) d.maint.push({ table: f[1]!, analyzeAt: Number(f[2]) * 1000, vacuumAt: Number(f[3]) * 1000 });
        else if (f[0] === 'stmt' && f.length >= 5) (d.stmts ??= []).push({ id: f[1]!, calls: Number(f[2]) || 0, totalMs: Number(f[3]) || 0, query: f.slice(4).join('\t') });
        else if (f[0] === 'queue' && f.length >= 4) d.queues.push({ name: f[1]!, depth: Number(f[2]) || 0, ageS: Number(f[3]) || 0 });
      }
      pg.push(d);
    }
  }
  const apiTotal = num(sec.get('apiserver'));
  if (!apiserver) unknown.push('kubelet-skew');
  if (apiTotal == null || nodes.some((n) => n.requests == null)) unknown.push('api-source');
  for (const n of nodes) {
    if (!n.cpu) unknown.push(`steal/${n.name}`);
    if (n.benchS == null) unknown.push(`cpu/${n.name}`);
  }
  return { ts: nowS != null ? nowS * 1000 : fallbackTs, apiserver, nodes, containers, apiTotal, pg, unknown };
}

// ---------- the signals ----------

/** kubelet older than the apiserver by more than this many minors is outside the supported skew (newer is never supported). */
export const SKEW_MAX_OLDER = 3;
/** A node sending at least this many requests a minute, and API_SOURCE_FACTOR × the median node, floods the apiserver.
 *  26/10: the six 1.34 kubelets sent ~600–1,100 a minute (PATCH+GET pods/status), the others 57–151. */
export const API_SOURCE_MIN_PER_MIN = 300;
export const API_SOURCE_FACTOR = 3;
/** steal over a round above this. srv1000002 22–26/10 (sar, 665 samples): median 9.3%, max 23.7%; 21/10 averaged 50.5%. */
export const STEAL_MAX_PERCENT = 25;
/** The shell loop took more than this × its 24h median on the node: the node gets less than half the CPU it used to. */
export const BENCH_FACTOR = 2;
/** …and only with steal above this in the same round. The loop runs in a pod on the node, so our own load slows it too: on 27/10
 *  vmi1000014 (lumo) was 35% busy with 7.4% iowait during a DB move and 0% steal, and the loop on tiki's nodes ran 0.04–0.60s by
 *  load and CPU model with 0.0% steal. Without steal a slow loop is not a finding. */
export const BENCH_STEAL_MIN_PERCENT = 3;
/** A baseline needs this many samples before anything is compared to it (an hour at `every: 5m`). */
export const BASELINE_MIN = 12;
/** Restarts of a container on OOMKilled within OOM_WINDOW_MS that make a loop. wabridge 26/10: 7 within ~10 minutes. */
export const OOM_LOOP_RESTARTS = 3;
export const OOM_WINDOW_MS = 30 * 60_000;
/** Known noise, generically: a container crash-looping with this many restarts in a pod older than CHRONIC_AGE_MS has done so
 *  for long before anyone asked (whatsapp-ai 2,213, legacy-restarter 2,005 on 26/10). It is not a new root. */
export const CHRONIC_RESTARTS = 20;
export const CHRONIC_AGE_MS = 6 * 3_600_000;
/** A client query still running after this long. botgw's Due ran ~60s each after the plan flip of 26/10 (normally < 1s). */
export const PG_SLOW_S = 10;
/** A query that ran this long in this many rounds of the day before is how that query is (a report), not a new root. */
export const PG_CHRONIC_ROUNDS = 6;
/** An analyze/vacuum on a table the query reads, this long before it, is named as the likely trigger. */
export const PG_MAINT_WINDOW_MS = 30 * 60_000;
/** pg_stat_statements: a statement's mean over a round above this × its 24h median, and at least PG_STMT_MIN_MS, over PG_STMT_MIN_CALLS calls. */
export const PG_STMT_FACTOR = 5;
export const PG_STMT_MIN_MS = 200;
export const PG_STMT_MIN_CALLS = 5;
/** A queue's oldest pending row older than QUEUE_FACTOR × its 24h median age, and at least QUEUE_MIN_AGE_S. */
export const QUEUE_FACTOR = 5;
export const QUEUE_MIN_AGE_S = 600;
/** …or its depth above QUEUE_FACTOR × its 24h median and at least this (tamar, 26/10: over 2,000 is not a normal day; normally ~0). */
export const QUEUE_MIN_DEPTH = 2000;
const DAY = 86_400_000;

export type Signal = 'kubelet-skew' | 'api-source' | 'cpu-steal' | 'cpu-received' | 'oom-loop' | 'crashloop' | 'pg-slow' | 'pg-stmt' | 'queue-stall';
/** root: a cause, may reach the owner. symptom: what a cause does, listed beside it. note: a state for רותם only. */
export type Role = 'root' | 'symptom' | 'note';
export const ROLE: Record<Signal, Role> = {
  'kubelet-skew': 'root', 'api-source': 'root', 'cpu-steal': 'root', 'cpu-received': 'root', 'oom-loop': 'root',
  'crashloop': 'symptom', 'pg-slow': 'root', 'pg-stmt': 'root', 'queue-stall': 'symptom',
};
/** Rounds in a row (a single missing round doesn't break it) before רותם hears of it. */
export const SUSTAIN: Record<Signal, number> = {
  'kubelet-skew': 2, 'api-source': 2, 'cpu-steal': 3, 'cpu-received': 3, 'oom-loop': 2, 'crashloop': 2, 'pg-slow': 2, 'pg-stmt': 2, 'queue-stall': 2,
};
/** A root reaches the owner after this many rounds and ROOT_OWNER_MS, and only with a symptom beside it. */
export const OWNER_ROUNDS = 3;
export const ROOT_OWNER_MS = 10 * 60_000;
/** A root of the cluster itself (`alone`: version skew, or sources with more than API_ALONE_SHARE of the apiserver's requests)
 *  reaches the owner after this long even with no symptom over a threshold: the PATCH loop of 26/10 ran 9 days, burning the
 *  master's CPU credits, and no symptom ever crossed one (rotem, rotem-4:mvpgsoml-0pc1d8996a). */
export const ROOT_ALONE_MS = 60 * 60_000;
export const API_ALONE_SHARE = 50;
/** A finding is over after this many rounds in a row without it. */
export const CLEAR_ROUNDS = 2;
/** Rounds in a row with no answer from a cluster before רותם hears its signals are blind (15 minutes at `every: 5m`). */
export const UNKNOWN_ROUNDS = 3;

/** `alone`: reaches the owner after ROOT_ALONE_MS without a symptom. */
export interface Finding { key: string; signal: Signal; subject: string; text: string; alone?: boolean }
export interface Sample { key: string; value: number }

/** What the past says, from root_samples. `to` is exclusive: the round being evaluated is not in it yet. */
export interface History {
  stats(key: string, from: number, to: number): { median: number; n: number };
  sum(key: string, from: number, to: number): number;
}

const minor = (v: string | null): number | null => { const m = /^v?1\.(\d+)/.exec(v ?? ''); return m ? Number(m[1]) : null; };
const median = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const hhmm = (ts: number): string => new Date(ts).toISOString().slice(11, 19);
const round1 = (n: number): number => Math.round(n * 10) / 10;
/** The workload a pod belongs to, stable when the pod is recreated: `wabridge-dc5bfb87c-wgpgm` → `wabridge`. Kubernetes' random
 *  suffixes have no vowels (`node-exporter-qxjps` → `node-exporter`, not `node`). */
export const workload = (pod: string): string => pod.replace(/-[bcdfghjklmnpqrstvwxz2-9]{6,10}-[bcdfghjklmnpqrstvwxz2-9]{5}$/, '').replace(/-[bcdfghjklmnpqrstvwxz2-9]{5}$/, '');
/** The tables a query reads or writes, as written in it (`botgw.deliveries`). */
export const queryTables = (q: string): string[] => {
  const ctes = new Set([...q.matchAll(/(?:\bwith(?:\s+recursive)?|,)\s+"?(\w+)"?\s+as\s*\(/gi)].map((m) => m[1]!.toLowerCase()));
  return [...new Set([...q.matchAll(/\b(?:from|join|update|into)\s+((?:"?\w+"?\.)?"?\w+"?)/gi)].map((m) => m[1]!.replace(/"/g, '').toLowerCase()))].filter((t) => !ctes.has(t));
};
const ignored = (ignore: string[], ns: string, pod: string): boolean => ignore.some((i) => i === ns || i === `${ns}/${workload(pod)}`);

/** One round: what is wrong now, and the samples that future rounds compare to. Pure: the history in, findings out. */
/** `open`: the findings open now. A loop that is open stays a loop when its restarts pass CHRONIC_RESTARTS: only what was
 *  already looping when we first saw it is chronic. */
/** `unknown`: more key prefixes this round could not see, beyond the snapshot's own (no steal without the round before). */
export function evaluate(prev: Snapshot | null, cur: Snapshot, h: History, ignore: string[] = [], open: Set<string> = new Set()): { findings: Finding[]; samples: Sample[]; unknown: string[] } {
  const findings: Finding[] = [];
  const samples: Sample[] = [];
  const now = cur.ts;
  const dayAgo = now - DAY;
  const unknown: string[] = [];

  // Version skew: kubelet newer than the apiserver, or too far behind it.
  const api = minor(cur.apiserver);
  const skewed = api == null ? [] : cur.nodes.filter((n) => { const k = minor(n.kubelet); return k != null && (k > api || api - k > SKEW_MAX_OLDER); });

  // Requests to the apiserver by source: each kubelet's own client counter, against the apiserver's total.
  const prevNode = new Map(prev?.nodes.map((n) => [n.name, n]) ?? []);
  const mins = prev ? (now - prev.ts) / 60_000 : 0;
  const rates = new Map<string, number>();
  if (mins >= 0.5) for (const n of cur.nodes) {
    const p = prevNode.get(n.name);
    if (n.requests != null && p?.requests != null && n.requests >= p.requests) rates.set(n.name, (n.requests - p.requests) / mins);
  }
  const med = median([...rates.values()]);
  const sources = [...rates].filter(([, r]) => r >= API_SOURCE_MIN_PER_MIN && r >= API_SOURCE_FACTOR * Math.max(med, 1)).sort((a, b) => b[1] - a[1]);
  const apiRate = prev && cur.apiTotal != null && prev.apiTotal != null && cur.apiTotal >= prev.apiTotal && mins >= 0.5 ? (cur.apiTotal - prev.apiTotal) / mins : null;
  const kubeletOf = new Map(cur.nodes.map((n) => [n.name, n.kubelet]));
  if (sources.length) {
    const sum = sources.reduce((s, [, r]) => s + r, 0);
    const share = apiRate ? Math.min(100, Math.round((100 * sum) / apiRate)) : null;
    findings.push({ key: 'api-source', signal: 'api-source', subject: `${sources.length} נודים`, alone: share != null && share > API_ALONE_SHARE,
      text: [`${sources.length} נודים מציפים את ה-apiserver: ${Math.round(sum)} בקשות לדקה${share != null ? `, ${share}% מכל הבקשות (${Math.round(apiRate!)} לדקה)` : ''}. נוד רגיל שולח ${Math.round(med)} לדקה.`,
        ...sources.map(([n, r]) => `- ${n}: ${Math.round(r)} לדקה, kubelet ${kubeletOf.get(n)}${skewed.some((s) => s.name === n) ? ` (חדש מה-apiserver ${cur.apiserver})` : ''}`)].join('\n') });
  }
  if (skewed.length) findings.push({ key: 'kubelet-skew', signal: 'kubelet-skew', subject: `${skewed.length} נודים`, alone: true,
    text: [`version skew: ${skewed.length} kubelets מחוץ לטווח הנתמך מול apiserver ${cur.apiserver} (kubelet לא יכול להיות חדש מה-apiserver, או ישן ממנו ביותר מ-${SKEW_MAX_OLDER} גרסאות):`,
      ...skewed.map((n) => `- ${n.name}: ${n.kubelet}${rates.has(n.name) ? `, ${Math.round(rates.get(n.name)!)} בקשות לדקה` : ''}`)].join('\n') });

  // CPU the machine got: steal from /proc/stat over the round, and a fixed shell loop against the node's own median. The loop is a
  // finding only with steal above BENCH_STEAL_MIN_PERCENT in the same round (our own load slows it too). A round with no steal reading
  // (no /proc/stat now or the round before, counters that went back) sees neither: unknown, so it closes nothing either.
  for (const n of cur.nodes) {
    const p = prevNode.get(n.name);
    let steal: number | null = null;
    let busy: number | null = null;
    if (n.cpu && p?.cpu && n.cpu.length >= 8 && p.cpu.length >= 8) {
      const d = n.cpu.slice(0, 8).map((v, i) => v - p.cpu![i]!);
      const total = d.reduce((s, v) => s + v, 0);
      if (total > 0 && d.every((v) => v >= 0)) {
        steal = (100 * d[7]!) / total;
        busy = (100 * (total - d[3]! - d[4]!)) / total;
        if (steal > STEAL_MAX_PERCENT) findings.push({ key: `steal/${n.name}`, signal: 'cpu-steal', subject: n.name,
          text: `steal ב-${n.name} (${n.ip}): ${round1(steal)}% מה-CPU בסבב האחרון (הסף ${STEAL_MAX_PERCENT}%), עסוק ${round1(busy)}%. הספק לא נותן למכונה את ה-CPU שלה.` });
      }
    }
    if (steal == null) unknown.push(`steal/${n.name}`, `cpu/${n.name}`);
    if (n.benchS != null) {
      const b = h.stats(`bench:${n.name}`, dayAgo, now);
      if (b.n >= BASELINE_MIN && b.median > 0 && n.benchS > BENCH_FACTOR * b.median && steal != null && busy != null && steal > BENCH_STEAL_MIN_PERCENT)
        findings.push({ key: `cpu/${n.name}`, signal: 'cpu-received', subject: n.name,
          text: `${n.name} (${n.ip}) מקבלת כ-${Math.round((100 * b.median) / n.benchS)}% מה-CPU שהיא מקבלת בדרך כלל: לולאה קבועה רצה ${n.benchS}s מול חציון של ${b.median}s ב-24 השעות האחרונות, steal ${round1(steal)}% בסבב, עסוק ${round1(busy)}%.` });
      samples.push({ key: `bench:${n.name}`, value: n.benchS });
    }
  }

  // OOMKilled and CrashLoop, in every namespace. Known noise: chronic loops (CHRONIC_*) and the probe's `ignore`.
  const prevC = new Map(prev?.containers.map((c) => [`${c.ns}/${c.pod}/${c.container}`, c]) ?? []);
  for (const c of cur.containers) {
    if (c.ns.endsWith('-dev') || ignored(ignore, c.ns, c.pod)) continue;
    const id = `${c.ns}/${workload(c.pod)}/${c.container}`;
    const looping = c.waiting === 'CrashLoopBackOff';
    if (looping && c.restarts >= CHRONIC_RESTARTS && c.startedAt != null && now - c.startedAt >= CHRONIC_AGE_MS
      && !open.has(`oom/${id}`) && !open.has(`crash/${id}`)) continue;
    const p = prevC.get(`${c.ns}/${c.pod}/${c.container}`);
    const delta = p ? Math.max(0, c.restarts - p.restarts) : 0;
    const oom = c.lastReason === 'OOMKilled';
    if (oom && delta > 0) samples.push({ key: `oom:${id}`, value: delta });
    const inWindow = h.sum(`oom:${id}`, now - OOM_WINDOW_MS, now) + (oom ? delta : 0);
    const recent = c.lastFinishedAt != null && now - c.lastFinishedAt <= OOM_WINDOW_MS;
    const where = `${c.ns}/${c.pod} (container ${c.container}, על ${c.node || '?'})`;
    if (oom && (inWindow >= OOM_LOOP_RESTARTS || (looping && recent && c.restarts >= OOM_LOOP_RESTARTS))) findings.push({ key: `oom/${id}`, signal: 'oom-loop', subject: `${c.ns}/${workload(c.pod)}`,
      text: `${where} נהרג על זיכרון בלולאה: OOMKilled, ${c.restarts} restarts${inWindow ? `, ${inWindow} מהם ב-${OOM_WINDOW_MS / 60_000} הדקות האחרונות` : ''}, המגבלה ${c.memLimit || 'לא מוגדרת'}${c.lastFinishedAt ? `, ההריגה האחרונה ב-${hhmm(c.lastFinishedAt)} UTC` : ''}.` });
    if (looping) findings.push({ key: `crash/${id}`, signal: 'crashloop', subject: `${c.ns}/${workload(c.pod)}`,
      text: `${where} ב-CrashLoopBackOff: ${c.restarts} restarts, הסיבה האחרונה ${c.lastReason || 'לא ידועה'}.` });
  }

  // Postgres, every database of every CNPG primary.
  const prevDb = new Map(prev?.pg.map((d) => [`${d.cluster}/${d.db}`, d]) ?? []);
  for (const d of cur.pg) {
    const at = `${d.cluster}/${d.db}`;
    const before = (tables: string[]) => d.maint.flatMap((m) => {
      if (!tables.some((t) => m.table === t || m.table.endsWith(`.${t}`))) return [];
      return ([['analyze', m.analyzeAt], ['vacuum', m.vacuumAt]] as const).filter(([, t]) => t > 0 && t <= now && now - t <= PG_MAINT_WINDOW_MS)
        .map(([what, t]) => `${what} על ${m.table} ב-${hhmm(t)} UTC, ${Math.round((now - t) / 60_000)} דקות לפני`);
    });
    const seen = new Set<string>();
    for (const a of d.active.filter((x) => x.secs >= PG_SLOW_S).sort((x, y) => y.secs - x.secs)) {
      if (seen.has(a.hash)) continue;
      seen.add(a.hash);
      samples.push({ key: `act:${at}/${a.hash}`, value: 1 });
      if (h.sum(`act:${at}/${a.hash}`, dayAgo, now - PG_MAINT_WINDOW_MS) >= PG_CHRONIC_ROUNDS) continue;
      const m = before(queryTables(a.query));
      findings.push({ key: `pg-slow/${at}/${a.hash}`, signal: 'pg-slow', subject: at,
        text: [`שאילתה ב-${at} רצה ${a.secs} שניות (הסף ${PG_SLOW_S}): ${a.query.slice(0, 160)}${a.query.length > 160 ? '…' : ''}`,
          m.length ? `ממש לפני: ${m.join('; ')}. כנראה התוכנית של השאילתה התחלפה.` : 'לא היה analyze או vacuum על הטבלאות שלה בחצי השעה שלפני.'].join('\n') });
    }
    const p = prevDb.get(at);
    if (d.stmts && p?.stmts) {
      const old = new Map(p.stmts.map((s) => [s.id, s]));
      for (const s of d.stmts) {
        const o = old.get(s.id);
        if (!o || s.calls - o.calls < PG_STMT_MIN_CALLS || s.totalMs < o.totalMs) continue;
        const mean = (s.totalMs - o.totalMs) / (s.calls - o.calls);
        const b = h.stats(`stmt:${at}/${s.id}`, dayAgo, now);
        samples.push({ key: `stmt:${at}/${s.id}`, value: mean });
        if (b.n < BASELINE_MIN / 2 || mean < PG_STMT_MIN_MS || mean <= PG_STMT_FACTOR * b.median) continue;
        const m = before(queryTables(s.query));
        findings.push({ key: `pg-stmt/${at}/${s.id}`, signal: 'pg-stmt', subject: at,
          text: [`הזמן הממוצע של שאילתה ב-${at} קפץ ל-${Math.round(mean)}ms מול ${round1(b.median)}ms ביום האחרון (${s.calls - o.calls} קריאות בסבב): ${s.query.slice(0, 160)}`,
            m.length ? `ממש לפני: ${m.join('; ')}. כנראה התוכנית של השאילתה התחלפה.` : 'לא היה analyze או vacuum על הטבלאות שלה בחצי השעה שלפני.'].join('\n') });
      }
    }
    for (const q of d.queues) {
      const key = `queue-age:${at}/${q.name}`;
      const b = h.stats(key, dayAgo, now);
      samples.push({ key, value: q.ageS });
      if (b.n < BASELINE_MIN || q.ageS < Math.max(QUEUE_MIN_AGE_S, QUEUE_FACTOR * b.median)) continue;
      findings.push({ key: `queue/${at}/${q.name}`, signal: 'queue-stall', subject: `${at} ${q.name}`,
        text: `התור ${q.name} ב-${at} עומד: ${q.depth > 100_000 ? 'יותר מ-100,000' : q.depth.toLocaleString('en-US')} ממתינים, הישן ביותר מ-${hhmm(now - q.ageS * 1000)} UTC (${Math.round(q.ageS / 60)} דקות). בדרך כלל הישן ביותר בן ${Math.round(b.median)} שניות.` });
    }
    // Depth: a queue that fills faster than it drains while its oldest is still young (a flood, not a stop).
    for (const q of d.queues) {
      const key = `queue-depth:${at}/${q.name}`;
      const b = h.stats(key, dayAgo, now);
      samples.push({ key, value: q.depth });
      if (b.n < BASELINE_MIN || q.depth < Math.max(QUEUE_MIN_DEPTH, QUEUE_FACTOR * b.median)) continue;
      if (findings.some((f) => f.key === `queue/${at}/${q.name}`)) continue; // already the stall, with its depth
      findings.push({ key: `queue-depth/${at}/${q.name}`, signal: 'queue-stall', subject: `${at} ${q.name}`,
        text: `התור ${q.name} ב-${at} מתמלא: ${q.depth > 100_000 ? 'יותר מ-100,000' : q.depth.toLocaleString('en-US')} ממתינים, בדרך כלל ${Math.round(b.median)}. הישן ביותר בן ${Math.round(q.ageS)} שניות.` });
    }
  }
  return { findings, samples, unknown };
}

// ---------- the watch ----------

export const collectCluster = (c: ClusterSpec, timeoutMs: number, run: SshRun = runSsh): Promise<string> =>
  run(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', ...(c.identityFile ? ['-i', c.identityFile] : []), c.ssh, 'bash -s'], CLUSTER_SCRIPT, timeoutMs);

interface FindingRow { cluster: string; key: string; signal: Signal; subject: string; text: string; first_seen: number; last_seen: number; rounds: number; misses: number; alone: number; lead_at: number | null; owner_at: number | null }

/** The http probes that fail now, for the owner's message beside a root (they are symptoms too). */
export type FailingHttp = () => string[];

export class RootWatch {
  private store: Store;
  private mailbox: Mailbox;
  private inbox: Inbox | null;
  private lead: string;
  /** The last snapshot of each cluster, for the deltas (counters, restarts). In memory: after a restart the first round has no deltas. */
  private last = new Map<string, Snapshot>();
  collect: (c: ClusterSpec, timeoutMs: number) => Promise<string> = (c, t) => collectCluster(c, t);
  failingHttp: FailingHttp = () => [];

  constructor(store: Store, mailbox: Mailbox, inbox: Inbox | null, lead: string) {
    this.store = store;
    this.mailbox = mailbox;
    this.inbox = inbox;
    this.lead = lead;
  }

  private history(cluster: string): History {
    const db = this.store.db;
    return {
      stats: (key, from, to) => {
        const v = (db.prepare('SELECT value FROM root_samples WHERE cluster = ? AND key = ? AND ts >= ? AND ts < ?').all(cluster, key, from, to) as { value: number }[]).map((r) => r.value);
        return { median: median(v), n: v.length };
      },
      sum: (key, from, to) => (db.prepare('SELECT COALESCE(SUM(value), 0) s FROM root_samples WHERE cluster = ? AND key = ? AND ts >= ? AND ts < ?').get(cluster, key, from, to) as { s: number }).s,
    };
  }

  /** One round on one cluster. An ssh failure or garbage is unknown: nothing opens, nothing closes. UNKNOWN_ROUNDS of them in a
   *  row tell רותם once that the cluster's signals are blind (and once when they see again). */
  async round(cluster: string, spec: ClusterSpec, timeoutMs: number): Promise<'ok' | 'unknown'> {
    let text: string | null = null, error = '';
    try { text = await this.collect(spec, timeoutMs); } catch (e) { error = (e as Error).message.slice(0, 300); }
    const snap = text == null ? null : parseSnapshot(text, this.store.now());
    if (text != null && !snap) error = `פלט לא מובן (אין nodes: kubectl לא ענה?): ${text.trim().slice(0, 120) || '(ריק)'}`;
    const key = `roots.unknown.${cluster}`;
    const streak = Number(this.store.getMeta(key) || '0');
    if (!snap) {
      this.store.emit('roots.unknown', this.lead, { cluster, error });
      this.store.setMeta(key, String(streak + 1));
      if (streak + 1 === UNKNOWN_ROUNDS) this.mailbox.tell({ msg_id: `roots-${cluster}-blind-${this.store.now()}`, from: 'hq', to: this.lead, kind: 'system', priority: 'next',
        body: `אותות השורש של ${cluster} עיוורים: ${UNKNOWN_ROUNDS} סבבים ברצף בלי תשובה (${spec.ssh}). האחרונה: ${error}. מה שפתוח שם לא נסגר ולא נפתח עד שהם חוזרים.` });
      return 'unknown';
    }
    if (streak >= UNKNOWN_ROUNDS) this.mailbox.tell({ msg_id: `roots-${cluster}-sees-${this.store.now()}`, from: 'hq', to: this.lead, kind: 'system', priority: 'next',
      body: `אותות השורש של ${cluster} חזרו לראות, אחרי ${streak} סבבים בלי תשובה.` });
    if (streak) this.store.setMeta(key, '0');
    this.observe(cluster, snap, spec.ignore);
    return 'ok';
  }

  /** Evaluate a snapshot and move the findings along: open, last, tell, close. */
  observe(cluster: string, snap: Snapshot, ignore: string[] = []): Finding[] {
    const prev = this.last.get(cluster) ?? null;
    const db = this.store.db;
    const rows = new Map((db.prepare('SELECT * FROM root_findings WHERE cluster = ?').all(cluster) as FindingRow[]).map((r) => [r.key, r]));
    const { findings, samples, unknown } = evaluate(prev, snap, this.history(cluster), ignore, new Set(rows.keys()));
    this.last.set(cluster, snap);
    const now = snap.ts;
    const ins = db.prepare('INSERT INTO root_samples (cluster, key, ts, value) VALUES (?, ?, ?, ?)');
    const closed: FindingRow[] = [];
    db.transaction(() => {
      for (const s of samples) ins.run(cluster, s.key, now, s.value);
      for (const f of findings) {
        const r = rows.get(f.key);
        if (r) db.prepare('UPDATE root_findings SET rounds = rounds + 1, misses = 0, last_seen = ?, text = ?, subject = ?, alone = ? WHERE cluster = ? AND key = ?').run(now, f.text, f.subject, f.alone ? 1 : 0, cluster, f.key);
        else db.prepare('INSERT INTO root_findings (cluster, key, signal, subject, text, first_seen, last_seen, rounds, misses, alone) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)')
          .run(cluster, f.key, f.signal, f.subject, f.text, now, now, f.alone ? 1 : 0);
      }
      const live = new Set(findings.map((f) => f.key));
      for (const r of rows.values()) {
        if (live.has(r.key) || [...snap.unknown, ...unknown].some((u) => r.key === u || (u.endsWith('/') && r.key.startsWith(u)))) continue;
        if (r.misses + 1 >= CLEAR_ROUNDS) { db.prepare('DELETE FROM root_findings WHERE cluster = ? AND key = ?').run(cluster, r.key); closed.push(r); }
        else db.prepare('UPDATE root_findings SET misses = misses + 1 WHERE cluster = ? AND key = ?').run(cluster, r.key);
      }
    })();
    this.tellLead(cluster, now);
    this.tellOwner(cluster, now);
    this.recovered(cluster, closed, now);
    this.store.emit('roots.round', this.lead, { cluster, findings: findings.map((f) => f.key) });
    return findings;
  }

  private open(cluster: string): FindingRow[] {
    return this.store.db.prepare('SELECT * FROM root_findings WHERE cluster = ? ORDER BY first_seen, key').all(cluster) as FindingRow[];
  }

  /** What lasted SUSTAIN rounds and רותם hasn't heard of: one message for the cluster, `now` when a root is in it. */
  private tellLead(cluster: string, now: number): void {
    const due = this.open(cluster).filter((r) => r.misses === 0 && !r.lead_at && r.rounds >= SUSTAIN[r.signal]);
    if (!due.length) return;
    const roots = due.filter((r) => ROLE[r.signal] === 'root');
    const others = this.open(cluster).filter((r) => r.misses === 0 && !due.includes(r) && r.lead_at);
    const label = (r: FindingRow) => `${ROLE[r.signal] === 'root' ? 'שורש' : ROLE[r.signal] === 'symptom' ? 'סימפטום' : 'מצב'} (${r.signal}), מ-${hhmm(r.first_seen)} UTC, ${r.rounds} סבבים:\n${r.text}`;
    this.mailbox.tell({ msg_id: `roots-${cluster}-${now}`, from: 'hq', to: this.lead, kind: roots.length ? 'probe_anomaly' : 'system',
      ...(roots.length ? { urgency: 'urgent' as const } : {}), priority: roots.length ? 'now' : 'next',
      body: [`אותות שורש בקלאסטר ${cluster}:`, ...due.map(label),
        ...(others.length ? [['עדיין פתוחים מקודם:', ...others.map((r) => `- ${r.signal}: ${r.subject}`)].join('\n')] : []),
        roots.length ? `שורש שנמשך ${OWNER_ROUNDS} סבבים ויש לצידו סימפטום מגיע גם ${pre('ל', this.mailbox.names.owner.name)}; version skew, או נודים עם יותר מ-${API_ALONE_SHARE}% מהבקשות ל-apiserver, מגיעים אליו אחרי ${ROOT_ALONE_MS / 60_000} דקות גם בלי סימפטום. observe-only: לא נעשתה פעולה.` : 'observe-only: לא נעשתה פעולה.'].join('\n\n') });
    const set = this.store.db.prepare('UPDATE root_findings SET lead_at = ? WHERE cluster = ? AND key = ?');
    for (const r of due) set.run(now, cluster, r.key);
    this.store.emit('roots.lead', this.lead, { cluster, keys: due.map((r) => r.key) });
  }

  /** A root that lasted, with a symptom beside it (in this cluster, or an http probe failing): one urgent message to the owner.
   *  An `alone` root (the cluster's own: skew, an apiserver flood) also without one, once it lasted ROOT_ALONE_MS. For those,
   *  a CPU signal on the cluster (steal, a node getting less CPU) is a symptom: what the flood costs the machines. */
  private tellOwner(cluster: string, now: number): void {
    const open = this.open(cluster).filter((r) => r.misses === 0);
    const lasted = open.filter((r) => ROLE[r.signal] === 'root' && !r.owner_at && r.rounds >= OWNER_ROUNDS && now - r.first_seen >= ROOT_OWNER_MS);
    if (!lasted.length) return;
    const clusterRoot = (r: FindingRow) => r.signal === 'kubelet-skew' || r.signal === 'api-source';
    const cpu = lasted.some(clusterRoot) ? open.filter((r) => (r.signal === 'cpu-steal' || r.signal === 'cpu-received') && r.rounds >= SUSTAIN[r.signal]) : [];
    const symptoms = [...open.filter((r) => ROLE[r.signal] === 'symptom'), ...cpu];
    const http = this.failingHttp();
    const alone = lasted.filter((r) => r.alone === 1);
    const roots = symptoms.length || http.length ? lasted.filter((r) => !cpu.includes(r)) : alone.some((r) => now - r.first_seen >= ROOT_ALONE_MS) ? alone : [];
    if (!roots.length) return;
    const set = this.store.db.prepare('UPDATE root_findings SET owner_at = ? WHERE cluster = ? AND key = ?');
    // He already has this cluster's incident open: what joined it is one quiet line, not a second alarm.
    if (open.some((r) => r.owner_at)) {
      this.mailbox.tell({ msg_id: `roots-${cluster}-owner-more-${now}`, from: this.lead, to: OWNER, priority: 'next',
        body: [`באותו קלאסטר (${cluster}) נוסף עוד שורש שנמשך:`, ...roots.map((r) => r.text)].join('\n') });
      for (const r of roots) set.run(now, cluster, r.key);
      return;
    }
    const ref = `roots-${cluster}-${roots[0]!.key}-${roots[0]!.first_seen}`;
    const minutes = Math.round((now - roots[0]!.first_seen) / 60_000);
    const body = [`שורש בפרודקשן, בקלאסטר ${cluster}, כבר ${minutes} דקות:`, ...roots.map((r) => r.text),
      'מה הוא גורם:', ...symptoms.map((r) => `- ${r.text}`), ...http.map((k) => `- probe של http נכשל: ${k}`),
      ...(symptoms.length || http.length ? [] : [`- אף סימפטום לא עבר סף, אבל זה שורש של הקלאסטר עצמו שנמשך יותר מ-${ROOT_ALONE_MS / 60_000} דקות. כך רצה לולאת ה-PATCH של 26/10 תשעה ימים, וכילתה את ה-CPU credits של המאסטר.`]),
      `${this.mailbox.label(this.lead)} כבר על זה. observe-only: לא נעשתה פעולה על הפרודקשן.`].join('\n');
    this.mailbox.tell({ msg_id: `${ref}-owner`, from: this.lead, to: OWNER, kind: 'probe_anomaly', urgency: 'urgent', priority: 'now', body });
    this.inbox?.add({ kind: 'incident', urgency: 'urgent', from_identity: this.lead, ref, dedupe_key: ref,
      title: `שורש בפרודקשן: ${roots.map((r) => `${r.signal} ${r.subject}`).join(', ')}`, body });
    for (const r of roots) set.run(now, cluster, r.key);
    this.store.setMeta(`roots.owner_ref.${cluster}`, ref);
    this.store.emit('roots.owner', this.lead, { cluster, roots: roots.map((r) => r.key), symptoms: symptoms.map((r) => r.key), http });
  }

  private recovered(cluster: string, closed: FindingRow[], now: number): void {
    const told = closed.filter((r) => r.lead_at);
    if (told.length) this.mailbox.tell({ msg_id: `roots-${cluster}-recovered-${now}`, from: 'hq', to: this.lead, kind: 'system', priority: 'next',
      body: [`נסגרו בקלאסטר ${cluster} (${CLEAR_ROUNDS} סבבים בלי האות):`, ...told.map((r) => `- ${r.signal}: ${r.subject}, מ-${hhmm(r.first_seen)} עד ${hhmm(r.last_seen)} UTC`)].join('\n') });
    // His incident closes when the last root he was told of is over, with a line for each that closed on the way.
    const ownerClosed = closed.filter((x) => x.owner_at);
    if (!ownerClosed.length) return;
    const doneKey = `roots.owner_closed.${cluster}`;
    const lines = [...(this.store.getMeta(doneKey) || '').split('\n').filter(Boolean),
      ...ownerClosed.map((r) => `- ${r.signal} ${r.subject}, מ-${hhmm(r.first_seen)} עד ${hhmm(r.last_seen)} UTC`)];
    if (this.open(cluster).some((r) => r.owner_at)) { this.store.setMeta(doneKey, lines.join('\n')); return; }
    this.store.setMeta(doneKey, '');
    const key = `roots.owner_ref.${cluster}`;
    const ref = this.store.getMeta(key);
    if (!ref) return;
    this.mailbox.tell({ msg_id: `${ref}-owner-recovered`, from: this.lead, to: OWNER, priority: 'next',
      body: [`חזר לתקין בקלאסטר ${cluster}:`, ...lines].join('\n') });
    this.inbox?.resolveByRef('incident', ref);
    this.store.setMeta(key, '');
  }

  prune(olderThanMs = 7 * DAY): void {
    this.store.db.prepare('DELETE FROM root_samples WHERE ts < ?').run(this.store.now() - olderThanMs);
  }
}
