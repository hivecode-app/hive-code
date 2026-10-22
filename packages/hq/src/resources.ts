// Resources, stage 1 (memory/projects/agent-company/resources-design.md §4): who holds the memory, the CPU and the disk of each
// machine, by project. On 22/10 four of five failures came from what hq does not run (a project's docker, a CI runner, a
// Gradle daemon left after a build), and nobody knew whose it was. Every 30 seconds, per machine, hq reads the disk, the
// memory and load, `memory.current` / `cpu.stat` of each systemd unit in /sys/fs/cgroup, and `docker stats` / `docker system df`,
// each with a short timeout, and attributes what it finds to a project:
//   company-shift@<id>.service → the shift's task → its project;
//   ci-<project>.slice         → the project;
//   a docker container         → its compose project, or the `resources.map` table of hq.config.json;
//   anything else              → "לא מזוהה", always shown, with the cgroup's name.
// Memory is anon + shmem from `memory.stat` (not `memory.current`, which includes cache) so the holders add up to what "used" says.
// A part that failed to read is "לא נמדד" (`unmeasured`), never "fine" (principle 5). Samples are kept for a few hours.
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import type { Hq } from './hq.ts';
import { q } from './nodes.ts';
import { parseBytes } from './disk-watch.ts';
import { BUSY_REASON } from './scheduler.ts';
import type { LeaseView } from './leases.ts';

export const SAMPLE_EVERY_MS = 30_000;
export const KEEP_MS = 6 * 3600_000;
/** A cgroup smaller than this (and not a shift or a CI slice) is not worth a row. */
const MIN_OTHER_MB = 32;
const MB = 1024 ** 2;

export type Kind = 'shift' | 'ci' | 'docker' | 'other';
/** Parts of a machine's reading that can be missing. */
export type Part = 'disk' | 'memory' | 'cgroups' | 'docker' | 'docker-df';

export interface RawCgroup { path: string; memBytes: number; cpuUsec: number | null }
export interface RawContainer { id: string; name: string; memBytes: number; cpuPct: number; compose: string | null }
export interface Raw {
  mem?: { totalMb: number; availMb: number; load1: number; cpus: number };
  disk?: { pct: number; freeMb: number };
  cgroups?: RawCgroup[];
  containers?: RawContainer[];
  dockerDf?: { type: string; sizeMb: number; reclaimableMb: number }[];
  /** parts that ran and failed (rc other than "not installed"), or whose output was unreadable */
  unmeasured: Part[];
}

export interface Usage { kind: Kind; project: string | null; task: number | null; name: string; memMb: number; cpuPct: number | null }

// ── The reading script: sections, each with its own timeout, so one slow part costs only itself ──────────────────────────

export const FAST = String.raw`
run() { n=$1; t=$2; shift 2; printf '##%s\n' "$n"; timeout "$t" "$@"; printf '##rc %s %s\n' "$n" "$?"; }
meminfo() { grep -E '^(MemTotal|MemAvailable):' /proc/meminfo && cut -d' ' -f1 /proc/loadavg && nproc; }
cgroups() {
  cd /sys/fs/cgroup || return 1
  find . -mindepth 2 -maxdepth 7 -type d \( -name '*.service' -o -name '*.scope' -o -name 'ci-*.slice' \) 2>/dev/null | while IFS= read -r d; do
    m=''; c=''; a=''; sh=''
    read -r m < "$d/memory.current" 2>/dev/null || continue
    # anon + shmem, not memory.current: that one counts page cache, which the kernel gives back, and so adds up to more than "used"
    while read -r k v; do case $k in anon) a=$v;; shmem) sh=$v;; esac; done < "$d/memory.stat" 2>/dev/null
    [ -n "$a" ] && m=$((a + \${sh:-0}))
    while read -r k v; do [ "$k" = usage_usec ] && c=$v; done < "$d/cpu.stat" 2>/dev/null
    printf '%s\t%s\t%s\n' "\${d#./}" "$m" "$c"
  done
}
export -f meminfo cgroups
run memory 5 bash -c meminfo
run disk 5 df -Pk /
run cgroups 12 bash -c cgroups
`.replace(/\\\$/g, '$');

/** `docker system df` walks images and volumes: heavy on a big disk, so it is asked every DF_EVERY_MS, not every sample. */
const DF_EVERY_MS = 5 * 60_000;
const dockerScript = (withDf: boolean) => String.raw`
run() { n=$1; t=$2; shift 2; printf '##%s\n' "$n"; timeout "$t" "$@"; printf '##rc %s %s\n' "$n" "$?"; }
run docker-ps 8 docker ps --format '{{.ID}}\t{{.Label "com.docker.compose.project"}}'
run docker 15 docker stats --no-stream --format '{{.ID}}\t{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
` + (withDf ? String.raw`run docker-df 20 docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'
` : '');

type Run = (script: string, timeoutMs: number) => Promise<string>;

/** Splits the sections of a script's output: name → {body, rc}. A section without its `##rc` line never finished. */
export function sections(out: string): Map<string, { body: string; rc: number | null }> {
  const res = new Map<string, { body: string; rc: number | null }>();
  let cur: string | null = null, buf: string[] = [];
  for (const line of out.split('\n')) {
    const rc = /^##rc (\S+) (\d+)$/.exec(line);
    const head = /^##([\w-]+)$/.exec(line);
    if (rc) { if (cur === rc[1]) res.set(cur, { body: buf.join('\n'), rc: Number(rc[2]) }); cur = null; buf = []; }
    else if (head) { if (cur) res.set(cur, { body: buf.join('\n'), rc: null }); cur = head[1]!; buf = []; }
    else if (cur) buf.push(line);
  }
  if (cur) res.set(cur, { body: buf.join('\n'), rc: null });
  return res;
}

const NOT_INSTALLED = 127;

/** FAST and DOCKER outputs → Raw. A part with rc != 0 or unreadable text is `unmeasured`; docker not installed is simply absent. */
export function parseRaw(fast: string | null, docker: string | null): Raw {
  const raw: Raw = { unmeasured: [] };
  const bad = (p: Part) => { if (!raw.unmeasured.includes(p)) raw.unmeasured.push(p); };
  if (fast == null) raw.unmeasured.push('memory', 'disk', 'cgroups');
  else {
    const s = sections(fast);
    const mem = s.get('memory');
    if (mem?.rc === 0) {
      const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mem.body)?.[1] ?? NaN);
      const [load1, cpus] = mem.body.trim().split('\n').slice(-2).map(Number);
      const v = { totalMb: Math.floor(kb('MemTotal') / 1024), availMb: Math.floor(kb('MemAvailable') / 1024), load1: load1 ?? NaN, cpus: cpus ?? NaN };
      if (Object.values(v).every(Number.isFinite)) raw.mem = v; else bad('memory');
    } else bad('memory');
    const disk = s.get('disk');
    const cols = disk?.rc === 0 ? disk.body.trim().split('\n').pop()!.trim().split(/\s+/) : [];
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    if (cols.length >= 6 && /^\d+%$/.test(cols[4]!)) raw.disk = { pct: parseInt(cols[4]!, 10), freeMb: Math.floor(Number(cols[3]) / 1024) };
    else bad('disk');
    const cg = s.get('cgroups');
    if (cg?.rc === 0 || (cg?.rc === 1 && cg.body.trim())) { // `while read … continue` may leave rc 1 on the last unreadable cgroup
      raw.cgroups = cg.body.split('\n').flatMap((l) => {
        const [path, m, c] = l.split('\t');
        return path && /^\d+$/.test(m ?? '') ? [{ path, memBytes: Number(m), cpuUsec: /^\d+$/.test(c ?? '') ? Number(c) : null }] : [];
      });
    } else bad('cgroups');
  }
  if (docker != null) {
    const s = sections(docker);
    const ps = s.get('docker-ps'), st = s.get('docker'), df = s.get('docker-df');
    if (ps?.rc !== NOT_INSTALLED && st?.rc !== NOT_INSTALLED) {
      if (ps?.rc === 0 && st?.rc === 0) {
        const compose = new Map(ps.body.split('\n').map((l) => l.split('\t')).filter((p) => p[0]).map((p) => [p[0]!, p[1] || null] as const));
        raw.containers = st.body.split('\n').flatMap((l) => {
          const [id, name, mem, cpu] = l.split('\t');
          if (!id || !name) return [];
          // "0B / 0B" is a real zero (a stopped-looking container); text that is not a size at all is a failed read, not a zero.
          if (!/^[\d.]+\s*[kKMGT]?i?B\b/.test(mem ?? '') || Number.isNaN(parseFloat(cpu ?? ''))) { bad('docker'); return []; }
          return [{ id, name, memBytes: parseBytes(mem!), cpuPct: parseFloat(cpu!), compose: compose.get(id) ?? null }];
        });
      } else bad('docker');
      if (df?.rc === 0) {
        raw.dockerDf = df.body.split('\n').flatMap((l) => {
          const [type, size, rec] = l.split('\t');
          return type && size ? [{ type, sizeMb: Math.round(parseBytes(size) / MB), reclaimableMb: Math.round(parseBytes(rec ?? '') / MB) }] : [];
        });
      } else if (df) bad('docker-df'); // not asked this time (see DF_EVERY_MS) is not a failure
    }
  } else bad('docker');
  return raw;
}

// ── Attribution ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AttrCtx {
  /** shift id → its task and project (a shift without a task: the identity's project, else null) */
  shift: (id: string) => { task: number | null; project: string | null } | null;
  /** project ids of org.yaml */
  projects: ReadonlySet<string>;
  /** resources.map: an exact name (a cgroup's last segment, a container, a compose project) → project id */
  map: Readonly<Record<string, string>>;
  /** docker was read: its containers are counted from `docker stats`, so their scopes in the cgroup tree are not counted again */
  dockerRead: boolean;
}

/** Pseudo-project for what is not a project of org.yaml but is known: Ran's own Claude sessions. */
export const OWNER_SESSIONS = 'owner-sessions';
const BUILTIN_NAMES: Record<string, string> = { [OWNER_SESSIONS]: 'הסשנים של רן' };
/** What the company runs on a machine, by the unit's own name: the default of `resources.map` (which wins over it). Exact names, then patterns. */
const DEFAULT_MAP: Record<string, string> = {
  'user@1001.service': 'agent-company', // hq, shift-host and node, and what Ran's login holds
  'chrome-personal.service': 'agent-company', 'playwright-mcp.service': 'agent-company', 'kasmvnc.service': 'agent-company', // the browser
  'gha-deploy.service': 'lumo',
};
const DEFAULT_PATTERNS: [RegExp, string][] = [[/^claude-remote@.+\.service$/, OWNER_SESSIONS]];
/** Project of a unit by default, from its last path segment. */
const defaultOf = (last: string): string | null => DEFAULT_MAP[last] ?? DEFAULT_PATTERNS.find(([re]) => re.test(last))?.[1] ?? null;
/** The company's own project: a shift with no task and no project (a permanent worker, the manager) is the company's. */
const COMPANY = 'agent-company';

const UNIT = /\.(service|scope)$/;

/** Raw cgroups and containers → rows. The cgroup tree is nested: only the outermost unit of a kind is counted, never a unit and its children. */
export function attribute(raw: Raw, ctx: AttrCtx, prev: Map<string, { usec: number; at: number }>, machine: string, now: number): Usage[] {
  const out: Usage[] = [];
  const mapped = (...names: (string | null | undefined)[]) => {
    for (const n of names) if (n && ctx.map[n]) return ctx.map[n]!;
    for (const n of names) { const d = n && defaultOf(n.split('/').pop()!); if (d) return d; }
    return null;
  };
  const cpuOf = (path: string, usec: number | null): number | null => {
    if (usec == null) return null;
    const key = `${machine}\0${path}`;
    const was = prev.get(key);
    prev.set(key, { usec, at: now });
    return was && now > was.at && usec >= was.usec ? Math.round(((usec - was.usec) / 1000 / (now - was.at)) * 1000) / 10 : null;
  };
  // A unit that holds shifts or CI slices (hq runs shifts as user units: user@1000.service/app.slice/company-shift@X.service) already
  // contains their memory: only its remainder is its own, never the whole again.
  const counted = (raw.cgroups ?? []).filter((c) => /(^|\/)(company-shift@.+\.service|ci-.+\.slice)$/.test(c.path));
  for (const c of raw.cgroups ?? []) {
    const seg = c.path.split('/');
    const last = seg[seg.length - 1]!;
    const memMb = Math.round((c.memBytes / MB) * 10) / 10;
    const shiftAt = seg.findIndex((s) => /^company-shift@.+\.service$/.test(s));
    const ciAt = seg.findIndex((s) => /^ci-.+\.slice$/.test(s));
    const dockerAt = seg.findIndex((s) => /^docker-[0-9a-f]{12,}\.scope$/.test(s));
    if (shiftAt >= 0) {
      if (shiftAt !== seg.length - 1) continue;
      const id = /^company-shift@(.+)\.service$/.exec(last)![1]!;
      const hit = ctx.shift(id);
      out.push({ kind: 'shift', project: hit ? (hit.project ?? COMPANY) : null, task: hit?.task ?? null, name: hit ? `משמרת ${id}` : c.path, memMb, cpuPct: cpuOf(c.path, c.cpuUsec) });
    } else if (ciAt >= 0) {
      if (ciAt !== seg.length - 1) continue;
      const slug = last.slice(3, -'.slice'.length);
      const project = mapped(last, slug) ?? (ctx.projects.has(slug) ? slug : null);
      out.push({ kind: 'ci', project, task: null, name: project ? `CI ${last}` : c.path, memMb, cpuPct: cpuOf(c.path, c.cpuUsec) });
    } else if (dockerAt >= 0) {
      if (ctx.dockerRead) continue;
      if (dockerAt === seg.length - 1) out.push({ kind: 'docker', project: null, task: null, name: c.path, memMb, cpuPct: cpuOf(c.path, c.cpuUsec) });
    } else if (UNIT.test(last) && seg.findIndex((s) => UNIT.test(s)) === seg.length - 1) {
      const project = mapped(last, c.path);
      const inside = counted.filter((x) => x.path.startsWith(`${c.path}/`) && !counted.some((y) => y !== x && x.path.startsWith(`${y.path}/`)));
      const own = Math.max(0, memMb - Math.round((inside.reduce((n, x) => n + x.memBytes, 0) / MB) * 10) / 10);
      if (project || own >= MIN_OTHER_MB) out.push({ kind: 'other', project, task: null, name: inside.length ? `${c.path} (בלי המשמרות וה-CI שבתוכו)` : c.path, memMb: own, cpuPct: cpuOf(c.path, c.cpuUsec) });
    }
  }
  for (const k of raw.containers ?? []) {
    const project = mapped(k.name, k.compose) ?? (k.compose && ctx.projects.has(k.compose) ? k.compose : null);
    out.push({ kind: 'docker', project, task: null, name: k.compose ? `${k.name} (${k.compose})` : k.name, memMb: Math.round((k.memBytes / MB) * 10) / 10, cpuPct: k.cpuPct });
  }
  return out;
}

// ── Machines ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Machine {
  /** `local` for this one, else the node's / witness's name */
  name: string;
  /** null = not to be read now (a node that is off or down); `why` says it */
  run: Run | null;
  why?: string;
}

function localRun(script: string, timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => execFile('bash', ['-c', script], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (e, out) => (e && !out ? rej(e) : res(String(out)))));
}

/** ssh to a witness host (no master), the same way probes.ts reaches ci-host. */
function sshRun(ssh: string, identityFile: string | null): Run {
  return (script, timeoutMs) => new Promise((res, rej) => {
    const args = [...(identityFile ? ['-i', identityFile] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ssh, `bash -c ${q(script)}`];
    execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (e, out) => (e && !out ? rej(e) : res(String(out))));
  });
}

export interface MachineView {
  name: string;
  label: string;
  /** false = no reading yet, or an old one: nothing below is a measurement of now */
  measured: boolean;
  at: number | null;
  error: string | null;
  unmeasured: Part[];
  mem: { total_mb: number; avail_mb: number; used_mb: number } | null;
  load1: number | null;
  cpus: number | null;
  disk: { pct: number; free_mb: number } | null;
  docker_df: { type: string; size_mb: number; reclaimable_mb: number }[] | null;
  /** who holds what, by project, biggest first; project null = לא מזוהה */
  holders: { project: string | null; name: string; mem_mb: number; cpu_pct: number | null; count: number; kinds: Kind[] }[];
  /** the unidentified, one row each, with their cgroup / container name */
  unidentified: { kind: Kind; name: string; mem_mb: number }[];
}

/** A task held back for the machine: for whom it waits (a sentence) and in how many minutes it is expected to start; null = not known. */
export interface WaitingTask { task: number; ref: string | null; title: string; project: string | null; waiting_min: number; waiting_for: string | null; eta_min: number | null }
export interface ResourcesView { at: number; machines: MachineView[]; waiting: WaitingTask[]; leases: LeaseView[] }

export class Resources {
  private hq: Hq;
  /** Replaced in tests. */
  machines: () => Machine[];
  private prev = new Map<string, { usec: number; at: number }>();
  private dfAt = new Map<string, number>();
  private label: string;

  constructor(hq: Hq, machines?: () => Machine[]) {
    this.hq = hq;
    this.label = hostname();
    this.machines = machines ?? (() => {
      const w = hq.cfg.probeWitness;
      return [
        { name: 'local', run: localRun },
        ...hq.nodes.list.map((n): Machine => (n.status?.up ? { name: n.def.name, run: (s, t) => n.exec(`bash -c ${q(s)}`, undefined, t) }
          : { name: n.def.name, run: null, why: n.status?.error ?? 'כבוי או שלא נבדק' })),
        ...(w ? [{ name: 'ci-host', run: sshRun(w.ssh, w.identityFile) }] : []),
      ];
    });
  }

  private ctx(dockerRead: boolean): AttrCtx {
    const { db } = this.hq.store;
    const q1 = db.prepare(`SELECT s.task_id AS task, COALESCE(t.project, i.project) AS project FROM shifts s
      LEFT JOIN tasks t ON t.id = s.task_id LEFT JOIN identities i ON i.id = s.identity WHERE s.id = ?`);
    return {
      shift: (id) => (q1.get(id) as { task: number | null; project: string | null } | undefined) ?? null,
      projects: new Set(this.hq.projects().map((p) => p.id)),
      map: this.hq.cfg.resources.map,
      dockerRead,
    };
  }

  /** One reading of every machine, in parallel. Never throws: a machine that fails is stored as not measured. */
  async sample(): Promise<void> {
    await Promise.all(this.machines().map((m) => this.sampleOne(m).catch((e: Error) => this.store(m.name, { unmeasured: ['memory', 'disk', 'cgroups', 'docker'] }, [], e.message))));
  }

  private async sampleOne(m: Machine): Promise<void> {
    if (!m.run) return this.store(m.name, { unmeasured: ['memory', 'disk', 'cgroups', 'docker'] }, [], m.why ?? 'לא נקרא');
    const now0 = this.hq.store.now();
    const withDf = now0 - (this.dfAt.get(m.name) ?? 0) >= DF_EVERY_MS;
    if (withDf) this.dfAt.set(m.name, now0);
    const [fast, docker] = await Promise.all([m.run(FAST, 30_000).catch((e: Error) => e), m.run(dockerScript(withDf), 40_000).catch((e: Error) => e)]);
    const err = (v: string | Error) => (v instanceof Error ? v : null);
    const raw = parseRaw(err(fast) ? null : (fast as string), err(docker) ? null : (docker as string));
    if (err(docker) && !err(fast)) raw.unmeasured = [...new Set([...raw.unmeasured, 'docker' as Part])];
    const error = err(fast) ? err(fast)!.message.slice(0, 300) : null;
    const at = this.hq.store.now();
    const rows = attribute(raw, this.ctx(!!raw.containers), this.prev, m.name, at);
    // Units that are gone (a shift that ended) leave the CPU baseline too.
    const live = new Set((raw.cgroups ?? []).map((c) => `${m.name}\0${c.path}`));
    for (const k of this.prev.keys()) if (k.startsWith(`${m.name}\0`) && !live.has(k)) this.prev.delete(k);
    if (!withDf && !raw.dockerDf) raw.dockerDf = this.lastDf(m.name); // not asked this time: the last answer stays
    this.store(m.name, raw, rows, error);
  }

  private lastDf(machine: string): Raw['dockerDf'] {
    const r = this.hq.store.db.prepare(`SELECT docker_df FROM resource_machine WHERE machine = ? ORDER BY at DESC LIMIT 1`).get(machine) as { docker_df: string | null } | undefined;
    return r?.docker_df ? JSON.parse(r.docker_df) : undefined;
  }

  private store(machine: string, raw: Raw, rows: Usage[], error: string | null): void {
    const { db } = this.hq.store;
    const at = this.hq.store.now();
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO resource_machine (at, machine, error, mem_total_mb, mem_avail_mb, load1, cpus, disk_pct, disk_free_mb, unmeasured, docker_df)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(at, machine, error, raw.mem?.totalMb ?? null, raw.mem?.availMb ?? null, raw.mem?.load1 ?? null, raw.mem?.cpus ?? null,
        raw.disk?.pct ?? null, raw.disk?.freeMb ?? null, JSON.stringify(raw.unmeasured), raw.dockerDf ? JSON.stringify(raw.dockerDf) : null);
      const ins = db.prepare(`INSERT INTO resource_usage (at, machine, kind, project, task, name, mem_mb, cpu_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) ins.run(at, machine, r.kind, r.project, r.task, r.name, r.memMb, r.cpuPct);
      db.prepare(`DELETE FROM resource_machine WHERE at < ?`).run(at - KEEP_MS);
      db.prepare(`DELETE FROM resource_usage WHERE at < ?`).run(at - KEEP_MS);
    })();
  }

  /** The newest reading of each machine, grouped by project. A reading older than 3 samples counts as not measured. */
  view(): ResourcesView {
    const { db } = this.hq.store;
    const now = this.hq.store.now();
    const names = [...new Set([...this.machines().map((m) => m.name), ...(db.prepare(`SELECT DISTINCT machine FROM resource_machine`).all() as { machine: string }[]).map((r) => r.machine)])];
    const machines: MachineView[] = names.map((name) => {
      const label = name === 'local' ? this.label : name;
      const r = db.prepare(`SELECT * FROM resource_machine WHERE machine = ? ORDER BY at DESC LIMIT 1`).get(name) as
        { at: number; error: string | null; mem_total_mb: number | null; mem_avail_mb: number | null; load1: number | null; cpus: number | null;
          disk_pct: number | null; disk_free_mb: number | null; unmeasured: string; docker_df: string | null } | undefined;
      if (!r) return { name, label, measured: false, at: null, error: 'עוד לא נקרא (אין קריאה אחת שנשמרה)', unmeasured: ['memory', 'disk', 'cgroups', 'docker'], mem: null, load1: null, cpus: null, disk: null, docker_df: null, holders: [], unidentified: [] };
      const unmeasured = JSON.parse(r.unmeasured) as Part[];
      const stale = now - r.at > 3 * SAMPLE_EVERY_MS;
      const rows = db.prepare(`SELECT kind, project, name, mem_mb, cpu_pct FROM resource_usage WHERE machine = ? AND at = ?`).all(name, r.at) as
        { kind: Kind; project: string | null; name: string; mem_mb: number; cpu_pct: number | null }[];
      const by = new Map<string, MachineView['holders'][number]>();
      for (const u of rows) {
        const key = u.project ?? '';
        const h = by.get(key) ?? { project: u.project, name: u.project ? (BUILTIN_NAMES[u.project] ?? this.hq.projectName(u.project)) : 'לא מזוהה', mem_mb: 0, cpu_pct: null, count: 0, kinds: [] };
        h.mem_mb = Math.round((h.mem_mb + u.mem_mb) * 10) / 10;
        if (u.cpu_pct != null) h.cpu_pct = Math.round(((h.cpu_pct ?? 0) + u.cpu_pct) * 10) / 10;
        h.count++;
        if (!h.kinds.includes(u.kind)) h.kinds.push(u.kind);
        by.set(key, h);
      }
      return {
        name, label, measured: !stale && !r.error, at: r.at, error: stale ? `אין קריאה חדשה מ-${new Date(r.at).toISOString().slice(11, 19)}` : r.error, unmeasured,
        mem: r.mem_total_mb != null ? { total_mb: r.mem_total_mb, avail_mb: r.mem_avail_mb!, used_mb: r.mem_total_mb - r.mem_avail_mb! } : null,
        load1: r.load1, cpus: r.cpus, disk: r.disk_pct != null ? { pct: r.disk_pct, free_mb: r.disk_free_mb! } : null,
        docker_df: r.docker_df ? (JSON.parse(r.docker_df) as { type: string; sizeMb: number; reclaimableMb: number }[]).map((d) => ({ type: d.type, size_mb: d.sizeMb, reclaimable_mb: d.reclaimableMb })) : null,
        holders: [...by.values()].sort((a, b) => b.mem_mb - a.mem_mb),
        unidentified: rows.filter((u) => !u.project).sort((a, b) => b.mem_mb - a.mem_mb).map((u) => ({ kind: u.kind, name: u.name, mem_mb: u.mem_mb })),
      };
    });
    const { scheduler } = this.hq;
    const slots = scheduler.slots();
    const busy = this.busy(machines.find((m) => m.name === 'local'));
    const waiting = scheduler.queue().filter((t) => scheduler.waitReason(t, slots) === BUSY_REASON)
      .map((t): WaitingTask => ({ task: t.id, ref: t.ref ?? null, title: t.title, project: t.project ?? null, waiting_min: Math.max(0, Math.round((now - (t.created_at ?? now)) / 60_000)), waiting_for: busy.waiting_for, eta_min: busy.eta_min }));
    return { at: now, machines, waiting, leases: this.hq.leases.active() };
  }

  /**
   * What a task held back for the machine waits for, in his words. Memory: who holds the most. Load: who uses the most CPU, and no
   * estimate. An estimate only when the holder is a project that holds a lease on the machine: the lease's expected end is then
   * that holder's; for an unidentified one, or any other, hq has no honest estimate and says none.
   */
  busy(local: MachineView | undefined = this.view().machines.find((m) => m.name === 'local')): { reason: 'memory' | 'load'; waiting_for: string | null; eta_min: number | null } {
    const gb = (mb: number) => `${(mb / 1024).toFixed(1)}GB`;
    const load = this.hq.scheduler.slots().pressure === 'load';
    const holders = local?.measured ? local.holders : [];
    if (load) {
      const top = [...holders].filter((h) => h.cpu_pct != null).sort((a, b) => b.cpu_pct! - a.cpu_pct!)[0];
      return { reason: 'load', waiting_for: top ? `${top.project ? top.name : 'צרכן לא מזוהה'} משתמש ב-${Math.round(top.cpu_pct!)}% מעבד` : null, eta_min: null };
    }
    const top = holders[0];
    const next = this.hq.leases.nextFree('local');
    const who = top ? (top.project ? `${top.name} מחזיק ${gb(top.mem_mb)}` : `צרכן לא מזוהה מחזיק ${gb(top.mem_mb)}`) : null;
    return { reason: 'memory', waiting_for: who, eta_min: next && top?.project && next.project === top.project ? next.eta_min : null };
  }

  /** "מי מחזיק" in a line, for the machine `local`: `לומו 6.1GB · החברה 9GB · לא מזוהה 3GB (name)`. null = nothing read. */
  holdersLine(machine = 'local', top = 5): string | null {
    const m = this.view().machines.find((x) => x.name === machine);
    if (!m) return null;
    if (!m.measured || !m.at) return 'לא נמדד: אין קריאה עדכנית של הפרויקטים';
    const gb = (mb: number) => `${(mb / 1024).toFixed(1)}GB`;
    const miss = m.unmeasured.filter((p) => p === 'cgroups' || p === 'docker');
    const lines = m.holders.slice(0, top).map((h) => (h.project
      ? `${h.name} ${gb(h.mem_mb)}`
      : `לא מזוהה ${gb(h.mem_mb)} (${m.unidentified.slice(0, 2).map((u) => u.name).join(', ')})`));
    if (miss.length) lines.push(`לא נמדד: ${miss.join(', ')}`);
    return lines.length ? lines.join(' · ') : null;
  }

  /** The worker's tool: short lines per machine, who holds what by project, who waits. */
  text(): string {
    const v = this.view();
    const gb = (mb: number) => `${(mb / 1024).toFixed(1)}`;
    const lines: string[] = [];
    for (const m of v.machines) {
      if (!m.at) { lines.push(`${m.label}: לא נמדד (אין קריאה עדיין)`); continue; }
      const head = [
        m.mem ? `זיכרון ${gb(m.mem.used_mb)} מתוך ${gb(m.mem.total_mb)}GB` : 'זיכרון: לא נמדד',
        m.load1 != null && m.cpus ? `עומס ${m.load1.toFixed(1)} על ${m.cpus} ליבות` : 'עומס: לא נמדד',
        m.disk ? `דיסק ${m.disk.pct}% (פנוי ${gb(m.disk.free_mb)}GB)` : 'דיסק: לא נמדד',
      ].join(' · ');
      lines.push(`${m.label}${m.measured ? '' : ` (לא נמדד עכשיו: ${m.error ?? 'בלי פרטים'})`}: ${head}`);
      const miss = m.unmeasured.filter((p) => p !== 'memory' && p !== 'disk');
      if (miss.length) lines.push(`  לא נמדד: ${miss.join(', ')}`);
      for (const h of m.holders.slice(0, 6)) {
        lines.push(`  ${h.project ? h.name : 'לא מזוהה'}: ${gb(h.mem_mb)}GB${h.cpu_pct != null ? `, מעבד ${h.cpu_pct}%` : ''} (${h.count} ${h.kinds.join('/')})`);
      }
      for (const u of m.unidentified.slice(0, 4)) lines.push(`  לא מזוהה · ${u.name} · ${gb(u.mem_mb)}GB`);
      if (m.docker_df?.length) lines.push(`  docker בדיסק: ${m.docker_df.map((d) => `${d.type} ${gb(d.size_mb)}GB`).join(', ')}`);
    }
    if (v.waiting.length) lines.push(`מחכים למקום: ${v.waiting.map((w) => `${w.ref ?? `#${w.task}`} ${w.title} (${w.waiting_min} דקות)`).join(' · ')}`);
    else lines.push('אף אחד לא מחכה למקום.');
    return lines.join('\n');
  }
}
