// resources stage 1: the reading's parsing, attribution to projects, "not measured" and the rolling table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { DEFAULT_HEAVY } from '../src/heavy.ts';
import { attribute, parseRaw, sections, type AttrCtx, type Machine } from '../src/resources.ts';

const FAST_OUT = `##memory
MemTotal:       24000000 kB
MemAvailable:   12000000 kB
1.50
8
##rc memory 0
##disk
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 100000000 80000000 20000000 80% /
##rc disk 0
##cgroups
system.slice/system-company\\x2dshift.slice/company-shift@agent-company-t394-1.service\t2147483648\t5000000
system.slice/system-company\\x2dshift.slice/company-shift@agent-company-t394-1.service/app.scope\t1048576\t10
system.slice/system-company\\x2dshift.slice/company-shift@ghost-9.service\t104857600\t
ci.slice/ci-lumo.slice\t3221225472\t9000000
ci.slice/ci-lumo.slice/gha-runner-ci-host@a.service\t3221225472\t9000000
ci.slice/ci-mystery.slice\t52428800\t1
system.slice/docker-0123456789abcdef.scope\t999999999\t1
system.slice/gradle.service\t7516192768\t1
system.slice/tiny.service\t1048576\t1
##rc cgroups 0
`;
const DOCKER_OUT = `##docker-ps
c1c1c1c1c1c1\teasy
d2d2d2d2d2d2\t
##rc docker-ps 0
##docker
c1c1c1c1c1c1\teasy-db-1\t1.5GiB / 23GiB\t12.5%
d2d2d2d2d2d2\tmystery-1\t200MiB / 23GiB\t0.3%
##rc docker 0
##docker-df
Images\t55GB\t40GB (72%)
Build Cache\t43GB\t43GB
##rc docker-df 0
`;
const ctx = (over: Partial<AttrCtx> = {}): AttrCtx => ({
  shift: (id) => (id === 'agent-company-t394-1' ? { task: 394, project: 'agent-company' } : null),
  projects: new Set(['agent-company', 'lumo', 'easy']), map: {}, dockerRead: true, ...over,
});

test('קריאה: זיכרון, דיסק, cgroups ו-docker נפרסים; docker לא מותקן אינו "לא נמדד"', () => {
  const raw = parseRaw(FAST_OUT, DOCKER_OUT);
  assert.deepEqual(raw.unmeasured, []);
  assert.deepEqual(raw.mem, { totalMb: 23437, availMb: 11718, load1: 1.5, cpus: 8 });
  assert.deepEqual(raw.disk, { pct: 80, freeMb: 19531 });
  assert.equal(raw.cgroups!.length, 9);
  assert.equal(raw.containers![0]!.compose, 'easy');
  assert.equal(raw.containers![0]!.memBytes, 1.5 * 1024 ** 3);
  assert.equal(raw.dockerDf![0]!.sizeMb, 55 * 1024);
  const none = parseRaw(FAST_OUT, `##docker-ps\n##rc docker-ps 127\n##docker\n##rc docker 127\n##docker-df\n##rc docker-df 127\n`);
  assert.deepEqual(none.unmeasured, []);
  assert.equal(none.containers, undefined);
});

test('חלק שנכשל או נחתך מסומן "לא נמדד", לא נעלם', () => {
  const cut = FAST_OUT.replace('##rc disk 0\n', '##rc disk 124\n').replace('##rc cgroups 0\n', '');
  const raw = parseRaw(cut, `##docker-ps\n##rc docker-ps 1\n`);
  assert.ok(raw.unmeasured.includes('disk') && raw.unmeasured.includes('cgroups') && raw.unmeasured.includes('docker'));
  assert.equal(raw.disk, undefined);
  assert.deepEqual(parseRaw(null, null).unmeasured.sort(), ['cgroups', 'disk', 'docker', 'memory']);
  assert.equal(sections('##a\nx\n').get('a')!.rc, null);
});

test('ייחוס: משמרת→משימה→פרויקט, ci-slice, docker, וכל השאר "לא מזוהה" עם השם; בלי ספירה כפולה', () => {
  const rows = attribute(parseRaw(FAST_OUT, DOCKER_OUT), ctx({ map: { 'mystery-1': 'lumo' } }), new Map(), 'local', 1000);
  const by = (n: RegExp) => rows.filter((r) => n.test(r.name));
  assert.deepEqual(by(/t394/).map((r) => [r.kind, r.project, r.task, r.memMb]), [['shift', 'agent-company', 394, 2048]]);
  assert.deepEqual(by(/ghost/).map((r) => [r.project, r.name.includes('ghost')]), [[null, true]]);
  assert.deepEqual(by(/ci-lumo/).map((r) => [r.kind, r.project, r.memMb]), [['ci', 'lumo', 3072]]);
  assert.equal(by(/gha-runner/).length, 0); // a child of the slice
  assert.equal(by(/app\.scope/).length, 0); // a child of a shift
  assert.equal(by(/docker-0123/).length, 0); // docker was read: counted from its stats
  assert.deepEqual(by(/ci-mystery/).map((r) => [r.project, r.name.includes('ci-mystery')]), [[null, true]]);
  assert.deepEqual(by(/gradle/).map((r) => [r.kind, r.project]), [['other', null]]);
  assert.equal(by(/tiny/).length, 0);
  assert.deepEqual(rows.filter((r) => r.kind === 'docker').map((r) => [r.name, r.project]), [['easy-db-1 (easy)', 'easy'], ['mystery-1', 'lumo']]);
  // docker not read: its scope is shown, unidentified
  const unread = attribute(parseRaw(FAST_OUT, null), ctx({ dockerRead: false }), new Map(), 'local', 1000);
  assert.deepEqual(unread.filter((r) => /docker-0123/.test(r.name)).map((r) => r.project), [null]);
});

test('משמרות כיחידות user: user@1000.service נספר רק על מה שנשאר בו, לא כפול', () => {
  const MBc = 1024 ** 2;
  const raw = { unmeasured: [], cgroups: [
    { path: 'user.slice/user-1000.slice/user@1000.service', memBytes: 9000 * MBc, cpuUsec: null },
    { path: 'user.slice/user-1000.slice/user@1000.service/app.slice/company-shift@agent-company-t394-1.service', memBytes: 4000 * MBc, cpuUsec: null },
    { path: 'user.slice/user-1000.slice/user@1000.service/app.slice/hq.service', memBytes: 500 * MBc, cpuUsec: null },
    { path: 'ci.slice/ci-lumo.slice', memBytes: 2000 * MBc, cpuUsec: null },
  ] };
  const rows = attribute(raw, ctx(), new Map(), 'local', 1);
  assert.equal(rows.reduce((n, r) => n + r.memMb, 0), 9000 + 2000);
  assert.deepEqual(rows.find((r) => r.kind === 'other')!.memMb, 5000);
  assert.equal(rows.filter((r) => r.kind === 'shift').length, 1);
});

test('docker: טקסט שאינו גודל הוא "לא נמדד", לא קונטיינר של 0', () => {
  const raw = parseRaw(FAST_OUT, `##docker-ps\nx1\t\n##rc docker-ps 0\n##docker\nx1\tweird\t??\t??\n##rc docker 0\n`);
  assert.ok(raw.unmeasured.includes('docker'));
  assert.deepEqual(parseRaw(FAST_OUT, `##docker-ps\nx1\t\n##rc docker-ps 0\n##docker\nx1\tidle\t0B / 0B\t0.00%\n##rc docker 0\n`).containers!.map((c) => c.memBytes), [0]);
});

test('מעבד: אחוז מההפרש בין שתי קריאות', () => {
  const prev = new Map();
  const at = (usec: number, now: number) => attribute({ unmeasured: [], cgroups: [{ path: 'system.slice/x.service', memBytes: 64 * 1024 ** 2, cpuUsec: usec }] }, ctx(), prev, 'm', now)[0]!.cpuPct;
  assert.equal(at(1_000_000, 0), null);
  assert.equal(at(16_000_000, 30_000), 50);
});

const ORG = `
version: 1
owner: ran
owner_name: רן
owner_gender: male
manager: yoav
monitoring_lead: rotem
timezone: Asia/Bangkok
teams:
  - {id: management, kind: permanent, symbol: account_tree, lead: yoav, members: []}
identities:
  - id: yoav
    name: יואב
    title: מנהל החברה
    symbol: explore
    team: management
    reports_to: ran
    lifecycle: always-on
    resident: true
    automations:
      - {id: pressure-watch, what: משימה דחופה שמחכה בגלל זיכרון, enabled: true}
      - {id: unidentified-watch, what: צרכן לא מזוהה שמחזיק זיכרון שעה, enabled: true}
`;

test('דגימה ל-DB, GET /api/resources והכלי: לפי פרויקט, "לא מזוהה" ו"לא נמדד" גלויים; הטבלה מתגלגלת', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  const good: Machine = { name: 'local', run: async (s) => (s.includes('docker-ps') ? DOCKER_OUT : FAST_OUT) };
  const down: Machine = { name: 'srv2', run: null, why: 'ssh timeout' };
  hq.resources.machines = () => [good, down];
  await hq.resources.sample();
  const v = hq.resources.view();
  const local = v.machines.find((m) => m.name === 'local')!;
  assert.equal(local.measured, true);
  assert.equal(local.disk!.pct, 80);
  assert.ok(local.holders.some((h) => h.project === null && h.mem_mb > 7000));
  assert.ok(local.unidentified.some((u) => u.name.includes('gradle')));
  const off = v.machines.find((m) => m.name === 'srv2')!;
  assert.equal(off.measured, false);
  assert.equal(off.error, 'ssh timeout');
  const text = hq.resources.text();
  assert.match(text, /לא מזוהה · system\.slice\/gradle\.service · 7\.0GB/);
  assert.match(text, /srv2.*לא נמדד/);
  assert.match(hq.resources.holdersLine()!, /לא מזוהה.*gradle/);
  assert.match(hq.resources.holdersLine('srv2')!, /^לא נמדד/);
  // an old reading is not a measurement of now
  clock.t += 5 * 60_000;
  assert.equal(hq.resources.view().machines.find((m) => m.name === 'local')!.measured, false);
  // rolling: a few hours only
  clock.t += 7 * 3600_000;
  await hq.resources.sample();
  assert.equal((hq.store.db.prepare(`SELECT COUNT(DISTINCT at) n FROM resource_machine WHERE machine = 'local'`).get() as { n: number }).n, 1);
  await env.cleanup();
});

test('pressure-watch: ההודעה אומרת מי מחזיק לפי פרויקט', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  hq.resources.machines = () => [{ name: 'local', run: async (s) => (s.includes('docker-ps') ? DOCKER_OUT : FAST_OUT) }];
  await hq.resources.sample();
  hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 3_500 });
  hq.pressureWatch.topProcs = async () => [];
  hq.scheduler.addTask({ title: 'p0 דחופה', priority: 0 });
  await hq.pressureWatch.sweep();
  clock.t += 11 * 60_000;
  await hq.resources.sample();
  await hq.pressureWatch.sweep();
  const item = hq.inbox.open().find((i) => i.kind === 'incident')!;
  assert.match(item.body, /מי מחזיק, לפי פרויקט: .*לא מזוהה/);
  await env.cleanup();
});

test('unidentified-watch: צרכן לא מזוהה גדול שעה ברצף הוא פריט אחד; קטן, או שנעלם באמצע, לא', async () => {
  const env = await makeEnv({ org: ORG, noStart: false });
  const { hq, clock } = env;
  let out = FAST_OUT;
  hq.resources.machines = () => [{ name: 'local', run: async (s) => (s.includes('docker-ps') ? DOCKER_OUT : out) }];
  const tick = async (min: number) => { clock.t += min * 60_000; await hq.resources.sample(); hq.unidentifiedWatch.sweep(); };
  const items = () => hq.inbox.open().filter((i) => i.kind === 'incident' && /לא מזוהה/.test(i.title) && /gradle/.test(i.body));
  await hq.resources.sample();
  hq.unidentifiedWatch.sweep();
  await tick(30);
  assert.equal(items().length, 0, 'half an hour is not yet');
  // it goes away for one reading: the hour starts again
  out = FAST_OUT.replace('system.slice/gradle.service\t7516192768', 'system.slice/gradle.service\t1048576');
  await tick(20);
  out = FAST_OUT;
  await tick(10);
  await tick(45);
  assert.equal(items().length, 0, 'the clock restarted');
  await tick(20);
  assert.equal(items().length, 1);
  assert.match(items()[0]!.title, /7\.0GB.*דקות/);
  assert.match(items()[0]!.body, /gradle/);
  await tick(10);
  assert.equal(items().length, 1, 'one item per incident');
  await env.cleanup();
});

test('unidentified-watch: כבויה (או בלי אוטומציה) לא שומרת שעון ולא מתריעה', async () => {
  const env = await makeEnv({ org: ORG.replace('unidentified-watch', 'something-else'), noStart: false });
  const { hq, clock } = env;
  hq.resources.machines = () => [{ name: 'local', run: async (s) => (s.includes('docker-ps') ? DOCKER_OUT : FAST_OUT) }];
  await hq.resources.sample();
  hq.unidentifiedWatch.sweep();
  clock.t += 2 * 3600_000;
  await hq.resources.sample();
  hq.unidentifiedWatch.sweep();
  assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM meta WHERE key LIKE 'unidentified_watch.%'`).get() as any).n, 0);
  await env.cleanup();
});

test('מסך המשאבים: הזמנות פעילות ותור, ומשימה שמחכה אומרת למי ובכמה זמן', async () => {
  const env = await makeEnv({ org: ORG, noStart: false, cfg: { heavy: { classes: DEFAULT_HEAVY, budgetPct: 65, machines: { local: { memMb: 10_000 } } } } });
  const { hq, clock } = env;
  hq.resources.machines = () => [{ name: 'local', run: async (s) => (s.includes('docker-ps') ? DOCKER_OUT : FAST_OUT) }];
  await hq.resources.sample();
  const db = hq.store.db;
  const ins = db.prepare(`INSERT INTO leases (identity, shift, task, project, class, machine, note, priority, mem_mb, cpu, exclusive, timeout_ms, state, created_at, polled_at, granted_at)
    VALUES ('eli', 'c-1', 7, 'agent-company', 'build', 'local', 'APK', 2, 8192, 4, NULL, 1800000, ?, ?, ?, ?)`);
  ins.run('granted', clock.t - 5 * 60_000, clock.t, clock.t - 5 * 60_000);
  ins.run('queued', clock.t - 60_000, clock.t, null);
  const v = hq.resources.view();
  assert.deepEqual(v.leases.map((l) => [l.state, l.class, l.project_name !== null, l.age_min]), [['granted', 'build', true, 5], ['queued', 'build', true, 1]]);
  assert.ok(v.leases[0]!.eta_min! >= 1);
  assert.match(v.leases[1]!.waiting_for ?? '', /build/);
  // a task held back for memory: who holds, and when a lease is expected to end
  hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 3_500 });
  hq.scheduler.loadInfo = () => ({ load1: 0.5, cpus: 8 });
  const t = hq.scheduler.addTask({ title: 'משימה שמחכה', project: 'agent-company' });
  const w = hq.resources.view().waiting.find((x) => x.task === t.id)!;
  assert.match(w.waiting_for ?? '', /לא מזוהה מחזיק \d+\.\dGB/);
  assert.equal(w.eta_min, null, 'an unidentified holder has no lease: no honest estimate');
  assert.match(hq.openTasks().find((x) => x.id === t.id)!.reason!, /^מחכה לזיכרון: צרכן לא מזוהה מחזיק \d+\.\dGB$/);
  // the biggest holder is a project that holds a lease: its lease's end is the estimate
  hq.cfg.resources.map['gradle.service'] = 'agent-company';
  const onlyGradle = FAST_OUT.split('\n').filter((l) => !/ci-|ghost|t394|docker-|tiny/.test(l)).join('\n');
  hq.resources.machines = () => [{ name: 'local', run: async (sc) => (sc.includes('docker-ps') ? `##docker-ps\n##rc docker-ps 127\n##docker\n##rc docker 127\n` : onlyGradle) }];
  clock.t += 30_000;
  await hq.resources.sample();
  assert.equal(hq.resources.view().waiting.find((x) => x.task === t.id)!.eta_min, v.leases[0]!.eta_min);
  assert.match(hq.openTasks().find((x) => x.id === t.id)!.reason!, /^מחכה לזיכרון: .* מחזיק \d+\.\dGB · כ-\d+ דקות$/);
  // too loaded rather than short of memory: it says so, who uses the CPU, and no estimate
  hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 20_000 });
  hq.scheduler.loadInfo = () => ({ load1: 40, cpus: 8 });
  const lo = hq.openTasks().find((x) => x.id === t.id)!.reason!;
  assert.match(lo, /^מחכה שהעומס יירד/);
  assert.doesNotMatch(lo, /דקות/);
  await env.cleanup();
});
