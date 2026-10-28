import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { makeEnv, until } from './helpers.ts';
import { ProbeRunner, loadProbes, parseCharterProbes, parseDuration, runHttpProbe, runDiskProbe, runLatencyProbe, parsePing, pingBreaches, sshWitness, sshPingWitness, jitterDigest, backfillLatencyRows, parsePingEvidence, runKubeletProbe, parseKubeletVersions } from '../src/probes.ts';

// The example company (fixtures/README.md): its charters declare probes the way a real company's do.
const COMPANY = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'company-home', 'company');

const CHARTER = (url: string) => `# lumo

אמנת הפרויקט.

\`\`\`yaml
probes:
  - {id: api-health, http: ${url}/health, every: 1m, expect: 200, fail_after: 3}
  - {id: slow, http: ${url}/slow, every: 30s, max_latency_ms: 50, fail_after: 1}
  - {id: k8s-rollout, k8s: {ns: lumo, deploy: server}, every: 2m}
\`\`\`

\`\`\`yaml
something_else: true
\`\`\`
`;

test('charter parsing: fenced yaml probes block and B.17 frontmatter monitoring', () => {
  const p = parseCharterProbes('lumo', CHARTER('http://x'));
  assert.deepEqual(p.map((x) => [x.key, x.kind, x.everyMs, x.failAfter]), [
    ['lumo/api-health', 'http', 60_000, 3], ['lumo/slow', 'http', 30_000, 1], ['lumo/k8s-rollout', 'unsupported', 120_000, 3],
  ]);
  const fm = parseCharterProbes('easy', '---\nmonitoring:\n  - {id: h, http: https://e/h, every: 5m, expect: [200, 204]}\n---\n# easy\n');
  assert.deepEqual(fm[0]!.expect, [200, 204]);
  assert.equal(fm[0]!.everyMs, 300_000);
  assert.equal(parseDuration('1d', 0), 86_400_000);
  assert.equal(parseDuration('bogus', 7), 7);
});

test('http probe: status, latency budget, connection errors', async () => {
  let status = 200;
  const srv = createServer((req, res) => {
    if (req.url === '/slow') setTimeout(() => { res.writeHead(200); res.end('ok'); }, 120);
    else { res.writeHead(status); res.end('x'); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const [health, slow] = parseCharterProbes('lumo', CHARTER(url));
    assert.equal((await runHttpProbe(health!)).ok, true);
    status = 502;
    const bad = await runHttpProbe(health!);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 502);
    const s = await runHttpProbe(slow!);
    assert.equal(s.ok, false);
    assert.match(s.error!, /latency/);
  } finally { srv.close(); }
  const [h] = parseCharterProbes('lumo', CHARTER('http://127.0.0.1:1'));
  const down = await runHttpProbe(h!);
  assert.equal(down.ok, false);
  assert.equal(down.status, null);
});

test('fail_after consecutive failures → one urgent message to רותם with evidence; recovery → one note', async () => {
  const env = await makeEnv({ projects: { lumo: CHARTER('http://lumo.test') } });
  try {
    const { hq, clock } = env;
    assert.equal(hq.probes.probes.length, 3);
    const outcomes: boolean[] = [false, false, false, false, true];
    hq.probes.run = async (p) => {
      const ok = p.id === 'api-health' ? (outcomes.shift() ?? true) : true;
      return { ok, status: ok ? 200 : 503, latencyMs: 12, error: ok ? null : 'status 503, expected 200' };
    };
    const toRotem = () => hq.store.db.prepare(`SELECT * FROM messages WHERE to_identity = 'rotem' ORDER BY created_at`).all() as
      { kind: string; urgency: string; priority: string; body: string }[];
    for (let i = 0; i < 2; i++) { await hq.probes.tick(); clock.advance(61_000); }
    assert.equal(toRotem().length, 0, 'no anomaly before fail_after');
    await hq.probes.tick(); clock.advance(61_000);
    const anomalies = toRotem().filter((m) => m.kind === 'probe_anomaly');
    assert.ok(anomalies.some((m) => /lumo\/api-health/.test(m.body)), 'api-health anomaly');
    const a = anomalies.find((m) => /api-health/.test(m.body))!;
    assert.equal(a.priority, 'now');
    assert.equal(a.urgency, 'urgent');
    assert.match(a.body, /status=503/);
    assert.match(a.body, /observe-only/);
    await hq.probes.tick(); clock.advance(61_000); // 4th failure
    assert.equal(toRotem().filter((m) => m.kind === 'probe_anomaly' && /api-health/.test(m.body)).length, 1, 'once per anomaly');
    outcomes.length = 0; // all ok from here
    await hq.probes.tick();
    assert.ok(toRotem().some((m) => m.kind === 'system' && /api-health חזר לתקין/.test(m.body)));
    assert.equal(hq.inbox.open().length, 0, 'probes never go to the owner directly — רותם asks him');

    hq.store.setToggle('rotem/prod-probes', false);
    clock.advance(10 * 60_000);
    const n = (hq.store.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as { n: number }).n;
    await hq.probes.tick();
    assert.equal((hq.store.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as { n: number }).n, n, 'toggle off = no runs');
  } finally { await env.cleanup(); }
});

test('#26: charters declare read-only http probes with a latency budget, and the switch is on (the example company)', () => {
  const probes = loadProbes(COMPANY).filter((p) => p.project === 'shop' || p.project === 'support-bot');
  for (const project of ['shop', 'support-bot']) assert.ok(probes.some((p) => p.project === project), `${project} has probes`);
  for (const p of probes) {
    assert.equal(p.kind, 'http', p.key);
    assert.equal(p.method, 'GET', `${p.key}: observe-only`);
    assert.match(p.url!, /^https:\/\//, p.key);
    assert.ok(p.maxLatencyMs && p.maxLatencyMs > 0, `${p.key}: response-time budget`);
    assert.ok(p.failAfter >= 2, `${p.key}: one failed probe is not proof`);
  }
  const org = parse(readFileSync(join(COMPANY, 'org.yaml'), 'utf8')) as { identities: { id: string; grants: unknown[]; automations: { id: string; enabled: boolean }[] }[] };
  const hadar = org.identities.find((i) => i.id === 'hadar')!;
  assert.equal(hadar.automations.find((a) => a.id === 'prod-probes')!.enabled, true);
  assert.deepEqual(hadar.grants, [], 'observe-only: no grants');
  for (const project of ['shop', 'support-bot']) {
    const fm = parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(COMPANY, 'projects', `${project}.md`), 'utf8'))![1]!) as { grants: unknown[] };
    assert.deepEqual(fm.grants, [], `${project}: no grants`);
  }
});

test('#26: a simulated outage on a charter\'s probe wakes the monitoring lead with evidence', async () => {
  const projects = Object.fromEntries(['shop', 'support-bot'].map((p) => [p, readFileSync(join(COMPANY, 'projects', `${p}.md`), 'utf8')]));
  // The charters are the example company's, the org is the test env's (helpers.ts): its monitoring lead is rotem.
  const env = await makeEnv({ projects });
  try {
    const { hq, clock, launcher } = env;
    assert.ok(hq.probes.probes.length >= 6);
    hq.probes.run = async (p) => p.key === 'shop/api'
      ? { ok: false, status: 502, latencyMs: 41, error: 'status 502, expected 403' }
      : { ok: true, status: p.expect[0]!, latencyMs: 30, error: null };
    for (let i = 0; i < 3; i++) { await hq.probes.tick(); clock.advance(61_000); }
    const anomaly = hq.store.db.prepare(`SELECT id, body, priority FROM messages WHERE to_identity = 'rotem' AND kind = 'probe_anomaly'`).all() as { id: string; body: string; priority: string }[];
    assert.equal(anomaly.length, 1, 'only the failing probe, once');
    assert.equal(anomaly[0]!.priority, 'now');
    assert.match(anomaly[0]!.body, /shop\/api \(GET https:\/\/api\.shop\.example\/v1\/products\)/);
    assert.equal(anomaly[0]!.body.match(/status=502 latency=41ms/g)!.length, 3, 'three lines of evidence');
    await until(() => hq.mailbox.get(anomaly[0]!.id)!.state === 'delivered', 3000, 'רותם woken and the anomaly delivered');
    assert.ok(launcher.launches.some((l) => l.shiftId.startsWith('rotem-')));
  } finally { await env.cleanup(); }
});

const FIVE = `# prod

\`\`\`yaml
probes:
${['north-depot', 'south-depot', 'east-depot', 'lumo', 'graph'].map((id) => `  - {id: ${id}, http: https://${id}.test/h, every: 1m, max_latency_ms: 2000, fail_after: 3}`).join('\n')}
\`\`\`
`;

test('witness: all five slow here, fine from ci-host → an event on hq-host, no anomaly', async () => {
  const env = await makeEnv({ projects: { prod: FIVE } });
  try {
    const { hq, clock } = env;
    hq.probes.run = async () => ({ ok: false, status: 200, latencyMs: 7000, error: 'latency 7000ms > 2000ms' });
    const asked: string[] = [];
    hq.probes.witness = async (p) => { asked.push(p.key); return { ok: true, status: 200, latencyMs: 300, error: null }; };
    hq.probes.host = () => ({ load1: 52, cpus: 8, freeMb: 0 });
    for (let i = 0; i < 3; i++) { await hq.probes.tick(); clock.advance(61_000); }
    assert.equal(asked.length, 5, 'asked only once they reached fail_after');
    const msgs = hq.store.db.prepare(`SELECT kind, priority, body FROM messages WHERE to_identity = 'rotem'`).all() as { kind: string; priority: string; body: string }[];
    assert.equal(msgs.filter((m) => m.kind === 'probe_anomaly').length, 0);
    assert.equal(msgs.length, 1, 'one note for the episode');
    assert.equal(msgs[0]!.priority, 'next');
    assert.match(msgs[0]!.body, /hq-host/);
    assert.match(msgs[0]!.body, /load 52/);
    assert.match(msgs[0]!.body, /0MB RAM/);
    const ev = hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'probe.measurer_fault'`).get() as { n: number };
    assert.ok(ev.n >= 1);
  } finally { await env.cleanup(); }
});

test('witness: a real outage that ci-host sees too still wakes רותם, with the confirmation in the evidence', async () => {
  const env = await makeEnv({ projects: { prod: FIVE } });
  try {
    const { hq, clock } = env;
    hq.probes.run = async (p) => p.id === 'east-depot' ? { ok: false, status: 503, latencyMs: 40, error: 'status 503, expected 200' } : { ok: true, status: 200, latencyMs: 40, error: null };
    hq.probes.witness = async () => ({ ok: false, status: 503, latencyMs: 55, error: 'status 503, expected 200' });
    for (let i = 0; i < 3; i++) { await hq.probes.tick(); clock.advance(61_000); }
    const a = hq.store.db.prepare(`SELECT body FROM messages WHERE to_identity = 'rotem' AND kind = 'probe_anomaly'`).all() as { body: string }[];
    assert.equal(a.length, 1);
    assert.match(a[0]!.body, /prod\/east-depot/);
    assert.match(a[0]!.body, /אומת גם מנקודה שנייה: status=503/);
  } finally { await env.cleanup(); }
});

test('witness: majority failing and ci-host unreachable → hold, then alert with a note after 2×fail_after', async () => {
  const env = await makeEnv({ projects: { prod: FIVE } });
  try {
    const { hq, clock } = env;
    hq.probes.run = async () => ({ ok: false, status: null, latencyMs: 10_000, error: 'timeout' });
    hq.probes.witness = async () => ({ unavailable: 'ssh timeout' });
    const anomalies = () => (hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string }[]);
    for (let i = 0; i < 5; i++) { await hq.probes.tick(); clock.advance(61_000); }
    assert.equal(anomalies().length, 0, 'held while the measurer is the likelier culprit');
    await hq.probes.tick();
    assert.equal(anomalies().length, 5);
    assert.match(anomalies()[0]!.body, /לא אומת מנקודה שנייה: ssh timeout/);
  } finally { await env.cleanup(); }
});

test('sshWitness: curl over ssh, same expectations as the probe', async () => {
  const [p] = parseCharterProbes('prod', FIVE);
  const calls: string[][] = [];
  const mk = (out: string | Error) => sshWitness({ ssh: 'root@ci-host', identityFile: '/k' }, async (args) => { calls.push(args); if (out instanceof Error) throw out; return out; });
  assert.deepEqual(await mk('200 0.250')(p!), { ok: true, status: 200, latencyMs: 250, error: null });
  assert.match(calls[0]!.join(' '), /-i \/k root@ci-host curl .*https:\/\/north-depot\.test\/h/);
  assert.equal(((await mk('200 3.100')(p!)) as { ok: boolean }).ok, false, 'latency budget applies');
  assert.equal(((await mk('000 5.000')(p!)) as { ok: boolean }).ok, false);
  assert.match(calls[0]!.join(' '), /-- 'https:\/\/north-depot\.test\/h'; true$/, 'curl exit code must not look like an ssh failure');
  assert.ok('unavailable' in (await mk(new Error('ssh exit 255'))(p!)));
  assert.ok('unavailable' in (await mk('garbage')(p!)));
});

test('witness: fine from ci-host but failing here for 2×fail_after → alert, a broken path only from hq-host', async () => {
  const env = await makeEnv({ projects: { prod: FIVE } });
  try {
    const { hq, clock } = env;
    hq.probes.run = async (p) => p.id === 'east-depot' ? { ok: false, status: null, latencyMs: 10_000, error: 'timeout' } : { ok: true, status: 200, latencyMs: 40, error: null };
    hq.probes.witness = async () => ({ ok: true, status: 200, latencyMs: 90, error: null });
    const a = () => hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string }[];
    for (let i = 0; i < 5; i++) { await hq.probes.tick(); clock.advance(61_000); }
    assert.equal(a().length, 0);
    await hq.probes.tick();
    assert.equal(a().length, 1);
    assert.match(a()[0]!.body, /נתיב שבור רק משם/);
  } finally { await env.cleanup(); }
});

const DISKS = `# nws

\`\`\`yaml
probes:
  - {id: kafka-disk, disk: 'root@203.0.113.12:/', identity: ~/.ssh/hakav_ed25519, every: 5m, max_percent: 80, fail_after: 2}
  - {id: local-disk, disk: 'local:/', every: 5m, max_percent: 80, fail_after: 2}
  - {id: bad, disk: nopath, every: 5m, max_percent: 80}
\`\`\`
`;

test('disk probe: parsing, over/under the threshold, no answer = unknown, garbage = unknown', async () => {
  const [k, l, bad] = parseCharterProbes('nws', DISKS);
  assert.deepEqual([k!.kind, l!.kind, bad!.kind], ['disk', 'disk', 'unsupported']);
  assert.equal(k!.disk!.host, 'root@203.0.113.12');
  assert.equal(k!.disk!.path, '/');
  assert.equal(l!.disk!.host, null);
  assert.match(k!.disk!.identityFile!, /\/\.ssh\/hakav_ed25519$/);
  const calls: string[][] = [];
  const mk = (out: string | Error) => async (args: string[]) => { calls.push(args); if (out instanceof Error) throw out; return out; };
  const over = await runDiskProbe(k!, mk('92%\n'));
  assert.equal(over.ok, false);
  assert.equal(over.percent, 92);
  assert.equal(over.unknown, undefined);
  assert.match(over.error!, /92%.*\/.*root@203\.0\.113\.12.*80%/);
  assert.match(calls[0]!.join(' '), /-i \S+hakav_ed25519 root@203\.0\.113\.12 df --output=pcent -- '\/' \| tail -1$/);
  assert.equal((await runDiskProbe(k!, mk(' 41%')) ).ok, true);
  assert.equal((await runDiskProbe(k!, mk('80%'))).ok, true, 'at the threshold is not over it');
  for (const bad of [new Error('ssh exit 255'), '', 'df: /x: No such file', '250%']) {
    const o = await runDiskProbe(k!, mk(bad));
    assert.equal(o.unknown, true, String(bad));
  }
  assert.equal((await runDiskProbe(l!, mk('x'), async () => 'Use%\n 97%\n')).percent, 97, 'local: no ssh');
  assert.equal(calls.length, 7, 'local never went through ssh');
});

test('disk probe: unknown never counts toward fail_after; over the threshold twice → anomaly with percent, path, server, no witness', async () => {
  const env = await makeEnv({ projects: { nws: DISKS } });
  try {
    const { hq, clock } = env;
    const seq: Array<'unknown' | number> = ['unknown', 95, 'unknown', 'unknown', 96, 50];
    hq.probes.run = async (p) => {
      if (p.id !== 'kafka-disk') return { ok: true, status: 10, latencyMs: 1, error: null, percent: 10 };
      const v = seq.shift()!;
      return v === 'unknown' ? { ok: false, unknown: true, status: null, latencyMs: 5, error: 'ssh timeout' }
        : { ok: v <= 80, percent: v, status: v, latencyMs: 5, error: v > 80 ? `${v}% בשימוש ב-/ על root@203.0.113.12, הסף 80%` : null };
    };
    hq.probes.witness = async () => { throw new Error('disk must not be verified from ci-host'); };
    const anomalies = () => hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string }[];
    const fails = () => (hq.store.db.prepare(`SELECT consecutive_failures n FROM probe_state WHERE probe_id = 'nws/kafka-disk'`).get() as { n: number }).n;
    const step = async () => { await hq.probes.tick(); clock.advance(5 * 60_000 + 1000); };
    await step(); // unknown
    await step(); // 95
    assert.equal(fails(), 1);
    await step(); await step(); // unknown ×2: the streak stays
    assert.equal(fails(), 1, 'unknown neither adds nor resets');
    assert.equal(anomalies().length, 0);
    await step(); // 96 → second failure
    assert.equal(anomalies().length, 1);
    assert.match(anomalies()[0]!.body, /דיסק \/ על root@203\.0\.113\.12, הסף 80%/);
    assert.match(anomalies()[0]!.body, /96% בשימוש ב-\//);
    await step(); // 50 → recovered
    assert.ok((hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'system'`).all() as { body: string }[]).some((m) => /kafka-disk חזר לתקין \(50%/.test(m.body)));
  } finally { await env.cleanup(); }
});

// The real output from hq-host on 22/10: vmi1000011 with jitter, a healthy node, and the master that drops ICMP.
const PING_JITTER = `PING 203.0.113.31 (203.0.113.31) 56(84) bytes of data.

--- 203.0.113.31 ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3839ms
rtt min/avg/max/mdev = 0.419/82.263/199.829/64.863 ms, pipe 2
`;
const PING_OK = `--- 203.0.113.37 ping statistics ---
20 packets transmitted, 20 received, 0% packet loss, time 3923ms
rtt min/avg/max/mdev = 0.271/0.390/1.066/0.165 ms
`;
const PING_LOSS = `--- 10.0.0.9 ping statistics ---
20 packets transmitted, 18 received, +2 errors, 10% packet loss, time 3901ms
rtt min/avg/max/mdev = 0.300/0.400/0.900/0.100 ms
`;
const PING_NONE = `--- 203.0.113.13 ping statistics ---
20 packets transmitted, 0 received, 100% packet loss, time 3946ms
`;

test('ping parser: iputils and busybox summaries; no reply or garbage → null', () => {
  assert.deepEqual(parsePing(PING_JITTER), { transmitted: 20, received: 20, lossPercent: 0, min: 0.419, avg: 82.263, max: 199.829, mdev: 64.863 });
  assert.deepEqual(parsePing(PING_LOSS), { transmitted: 20, received: 18, lossPercent: 10, min: 0.3, avg: 0.4, max: 0.9, mdev: 0.1 });
  const bb = parsePing('20 packets transmitted, 19 packets received, 5% packet loss\nround-trip min/avg/max = 0.3/0.5/1.2 ms\n');
  assert.equal(bb!.received, 19);
  assert.equal(bb!.avg, 0.5);
  assert.equal(bb!.mdev, null, 'busybox has no mdev');
  assert.deepEqual(parsePing(PING_NONE), { transmitted: 20, received: 0, lossPercent: 100, min: null, avg: null, max: null, mdev: null });
  assert.equal(parsePing('20 packets transmitted, 20 received, 0% packet loss\n'), null, 'replies without an rtt line is not ping output we know');
  assert.equal(parsePing(''), null);
  assert.equal(parsePing('ping: unknown host'), null);
});

test('ping thresholds: avg, mdev and loss each fail on their own; at the threshold is not over it', () => {
  const t = { maxAvgMs: 10, maxMdevMs: 20, maxLossPercent: 5 };
  const s = { transmitted: 20, received: 20, lossPercent: 0, min: 0.3, avg: 0.4, max: 1, mdev: 0.1 };
  assert.deepEqual(pingBreaches(s, t), []);
  assert.deepEqual(pingBreaches({ ...s, avg: 10, mdev: 20, lossPercent: 5 }, t), []);
  assert.deepEqual(pingBreaches({ ...s, avg: 10.1 }, t), ['avg מעל 10ms']);
  assert.deepEqual(pingBreaches({ ...s, mdev: 21 }, t), ['mdev מעל 20ms']);
  assert.deepEqual(pingBreaches({ ...s, lossPercent: 10 }, t), ['אובדן מעל 5%']);
  assert.equal(pingBreaches(parsePing(PING_JITTER)!, t).length, 2);
  assert.deepEqual(pingBreaches(parsePing(PING_NONE)!, t), ['אובדן מעל 5%']);
  assert.deepEqual(pingBreaches({ ...s, mdev: null }, t), [], 'no mdev is not a breach');
});

const LATENCY = `# tiki-bot-go

\`\`\`yaml
probes:
  - {id: net-vmi1000011, latency: 203.0.113.31, every: 5m, fail_after: 2}
  - {id: net-custom, latency: 203.0.113.37, max_avg_ms: 0.2, max_mdev_ms: 5, max_loss_percent: 0}
  - {id: bad, latency: '-f 1.2.3.4'}
  - {id: bad-threshold, latency: 1.2.3.4, max_avg_ms: 10ms}
\`\`\`
`;

test('latency probe: parsing, defaults, evidence; no reply at all fails; ping error / garbage = unknown', async () => {
  const [j, c, bad, badT] = parseCharterProbes('tiki-bot-go', LATENCY);
  assert.deepEqual([j!.kind, c!.kind, bad!.kind, badT!.kind], ['latency', 'latency', 'unsupported', 'unsupported']);
  assert.deepEqual(j!.latency, { host: '203.0.113.31', maxAvgMs: 10, maxMdevMs: 20, maxLossPercent: 5 });
  assert.deepEqual(c!.latency, { host: '203.0.113.37', maxAvgMs: 0.2, maxMdevMs: 5, maxLossPercent: 0 });
  assert.equal(j!.timeoutMs, 20_000, 'latency default timeout outlasts ping itself');
  const hosts: string[] = [];
  const mk = (out: string | Error) => async (h: string) => { hosts.push(h); if (out instanceof Error) throw out; return out; };
  const o = await runLatencyProbe(j!, mk(PING_JITTER));
  assert.equal(o.ok, false);
  assert.equal(o.unknown, undefined);
  assert.equal(o.latencyMs, 82);
  assert.match(o.error!, /^203\.0\.113\.31: min\/avg\/max\/mdev 0\.419\/82\.263\/199\.829\/64\.863ms, אובדן 0% \(avg מעל 10ms, mdev מעל 20ms\)$/);
  assert.equal((await runLatencyProbe(j!, mk(PING_OK))).ok, true);
  assert.match((await runLatencyProbe(j!, mk(PING_LOSS))).error!, /אובדן מעל 5%/);
  assert.equal((await runLatencyProbe(c!, mk(PING_OK))).ok, false, 'charter thresholds win');
  const none = await runLatencyProbe(j!, mk(PING_NONE));
  assert.equal(none.unknown, undefined);
  assert.equal(none.ok, false);
  assert.equal(none.latencyMs, null);
  assert.match(none.error!, /^203\.0\.113\.31: אין אף תשובה, אובדן 100% \(אובדן מעל 5%\)$/);
  assert.equal((await runLatencyProbe(j!, mk(new Error('spawn ping ENOENT')))).unknown, true);
  assert.equal((await runLatencyProbe(j!, mk('garbage'))).unknown, true);
  assert.deepEqual([...new Set(hosts)], ['203.0.113.31', '203.0.113.37']);
});

test('latency probe: loss crosses fail_after → anomaly with the ping evidence, no http witness; recovery note', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': LATENCY } });
  try {
    const { hq, clock } = env;
    const seq = [PING_LOSS, 'garbage', PING_LOSS, PING_OK];
    hq.probes.probes = hq.probes.probes.filter((p) => p.id === 'net-vmi1000011');
    hq.probes.run = (p) => runLatencyProbe(p, async () => seq.shift()!);
    hq.probes.witness = async () => { throw new Error('latency must not be verified by curl'); };
    const anomalies = () => hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string }[];
    const step = async () => { await hq.probes.tick(); clock.advance(5 * 60_000 + 1000); };
    await step(); await step(); // loss, then unreadable output (unknown: the streak stays at 1)
    assert.equal(anomalies().length, 0);
    await step(); // loss again → fail_after=2
    assert.equal(anomalies().length, 1);
    assert.match(anomalies()[0]!.body, /jitter ברשת אל 203\.0\.113\.31: הספים avg 10ms, mdev 20ms, אובדן 5%/);
    assert.match(anomalies()[0]!.body, /אובדן 10% \(אובדן מעל 5%\)/);
    await step(); // healthy
    assert.ok((hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'system'`).all() as { body: string }[])
      .some((m) => /net-vmi1000011 חזר לתקין \(203\.0\.113\.31: min\/avg\/max\/mdev 0\.271\/0\.39\/1\.066\/0\.165ms/.test(m.body)));
  } finally { await env.cleanup(); }
});

// probe-alerts-spec (26/10): jitter wakes no one, a shared loss is one event, the owner hears of it only when it lasts and is real.
const NODES = (n: number) => `# tiki-bot-go

\`\`\`yaml
probes:
${Array.from({ length: n }, (_, i) => `  - {id: net-vmi${1000 + i}, latency: 10.0.0.${i + 1}, every: 5m, fail_after: 3}`).join('\n')}
  - {id: api, http: https://api.test/h, every: 5m, fail_after: 2}
\`\`\`
`;
const lossOut = (pct: number) => `20 packets transmitted, ${20 - pct / 5} received, ${pct}% packet loss, time 3901ms\nrtt min/avg/max/mdev = 0.300/0.400/0.900/0.100 ms\n`;
const ROUND = 5 * 60_000;

/** A latency env: `lossy(host, round)` says which nodes lose pings; http answers per `httpOk`. */
async function netEnv(n: number, lossy: (host: string, round: number) => boolean, httpOk = () => true) {
  const env = await makeEnv({ projects: { 'tiki-bot-go': NODES(n) } });
  const { hq } = env;
  let round = 0;
  hq.probes.run = (p) => p.kind === 'http'
    ? Promise.resolve(httpOk() ? { ok: true, status: 200, latencyMs: 40, error: null } : { ok: false, status: 503, latencyMs: 40, error: 'status 503, expected 200' })
    : runLatencyProbe(p, async (h) => lossy(h, round) ? lossOut(20) : PING_OK);
  hq.probes.host = () => ({ load1: 0.5, cpus: 8, freeMb: 9000 });
  const step = async () => { await hq.probes.tick(); round++; env.clock.advance(ROUND); };
  const to = (who: string, kind?: string) => hq.store.db.prepare(`SELECT kind, priority, body FROM messages WHERE to_identity = ?${kind ? ' AND kind = ?' : ''} ORDER BY rowid`)
    .all(...(kind ? [who, kind] : [who])) as { kind: string; priority: string; body: string }[];
  return { env, hq, step, to };
}

test('spec 1: three jitter samples without loss send nothing and the streak stays 0', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': LATENCY } });
  try {
    const { hq, clock } = env;
    hq.probes.probes = hq.probes.probes.filter((p) => p.id === 'net-vmi1000011');
    hq.probes.run = (p) => runLatencyProbe(p, async () => PING_JITTER);
    for (let i = 0; i < 3; i++) { await hq.probes.tick(); clock.advance(ROUND + 1000); }
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE kind = 'probe_anomaly'`).get() as { n: number }).n, 0);
    const st = hq.store.db.prepare(`SELECT consecutive_failures, anomaly_open FROM probe_state WHERE probe_id = 'tiki-bot-go/net-vmi1000011'`).get() as { consecutive_failures: number; anomaly_open: number };
    assert.deepEqual({ ...st }, { consecutive_failures: 0, anomaly_open: 0 });
    const rows = hq.store.db.prepare(`SELECT ok, jitter, loss_percent, avg_ms, mdev_ms FROM probe_results`).all() as { ok: number; jitter: number; loss_percent: number; avg_ms: number; mdev_ms: number }[];
    assert.equal(rows.length, 3);
    assert.deepEqual({ ...rows[0]! }, { ok: 0, jitter: 1, loss_percent: 0, avg_ms: 82.263, mdev_ms: 64.863 }, 'recorded as jitter, with the numbers');
  } finally { await env.cleanup(); }
});

test('spec 2: three samples with 10% loss send one alert, as before', async () => {
  const { env, step, to } = await netEnv(1, () => true);
  try {
    for (let i = 0; i < 4; i++) await step();
    const a = to('rotem', 'probe_anomaly');
    assert.equal(a.length, 1);
    assert.equal(a[0]!.priority, 'now');
    assert.match(a[0]!.body, /tiki-bot-go\/net-vmi1000/);
  } finally { await env.cleanup(); }
});

test('spec 3: 12 nodes losing in one round → one combined message with 12 names, none per node', async () => {
  const lossy = new Set(Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`));
  const { env, hq, step, to } = await netEnv(16, (h, r) => r === 0 && lossy.has(h));
  try {
    hq.probes.pingWitness = async (hosts) => new Map(hosts.map((h) => [h, parsePing(PING_OK)]));
    await step();
    const a = to('rotem', 'probe_anomaly');
    assert.equal(a.length, 1);
    assert.match(a[0]!.body, /נפילה משותפת ברשת/);
    assert.match(a[0]!.body, /12 מתוך 16 נודים איבדו pings באותו סבב \(4 תקינים\)/);
    for (let i = 0; i < 12; i++) assert.match(a[0]!.body, new RegExp(`net-vmi${1000 + i} \\(10\\.0\\.0\\.${i + 1}\\): אובדן 20%`));
    assert.match(a[0]!.body, /load 0\.5 על 8 ליבות/);
    assert.match(a[0]!.body, /כל ה-1 תקינים/);
    assert.match(a[0]!.body, /ping מ-ci-host: 0 מתוך 12 מאבדים גם משם/);
    await step(); // back to normal
    assert.equal(to('rotem', 'probe_anomaly').length, 1);
    assert.ok(to('rotem', 'system').some((m) => /הנפילה המשותפת ברשת נגמרה/.test(m.body)));
    assert.equal(to('owner').length, 0, 'one round never reaches him');
  } finally { await env.cleanup(); }
});

test('spec 4: a shared loss that lasts two rounds reaches the owner (http failing); one round does not', async () => {
  const { env, hq, step, to } = await netEnv(16, (h, r) => r < 2 && Number(h.split('.')[3]) <= 12, () => false);
  try {
    hq.probes.pingWitness = async (hosts) => new Map(hosts.map((h) => [h, parsePing(lossOut(20))]));
    await step();
    assert.equal(to('owner').length, 0, 'after one round: nothing to him');
    await step();
    const o = to('owner');
    assert.equal(o.length, 1);
    assert.equal(o[0]!.kind, 'probe_anomaly');
    assert.equal(o[0]!.priority, 'now');
    assert.match(o[0]!.body, /נמשכת 5 דקות/);
    assert.match(o[0]!.body, /probes של http: 1 מתוך 1 נכשלים/);
    assert.match(o[0]!.body, /ping מ-ci-host: 12 מתוך 12 מאבדים גם משם/);
    const inbox = hq.inbox.open().filter((i) => i.kind === 'incident');
    assert.equal(inbox.length, 1, 'in "waiting for you"');
    assert.equal(to('rotem', 'probe_anomaly').filter((m) => /net-vmi/.test(m.body) && !/נפילה משותפת/.test(m.body)).length, 0, 'no per-node alert inside the event');
    await step(); // recovered
    assert.ok(to('owner').some((m) => /חזר לתקין/.test(m.body)));
    assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  } finally { await env.cleanup(); }
});

test('spec 4 (yoav): lasting, but every http fine and ci-host answers → stays with רותם; no witness → the owner', async () => {
  const lossy = (h: string) => Number(h.split('.')[3]) <= 6;
  const a = await netEnv(8, lossy);
  try {
    a.hq.probes.pingWitness = async (hosts) => new Map(hosts.map((h) => [h, parsePing(PING_OK)]));
    for (let i = 0; i < 4; i++) await a.step();
    assert.equal(a.to('owner').length, 0);
    const held = a.to('rotem', 'system').filter((m) => /לא יצאה התראה/.test(m.body));
    assert.equal(held.length, 1, 'one note that it was held');
    assert.match(held[0]!.body, /מ-ci-host הנודים תקינים/);
  } finally { await a.env.cleanup(); }
  const b = await netEnv(8, lossy);
  try {
    b.hq.probes.pingWitness = async () => ({ unavailable: 'ssh timeout' });
    await b.step(); await b.step();
    assert.equal(b.to('owner').length, 1);
    assert.match(b.to('owner')[0]!.body, /אין witness \(ssh timeout\)/);
  } finally { await b.env.cleanup(); }
});

test('spec 6: 3 nodes losing together alert per node as usual; 4 nodes give one combined alert', async () => {
  const three = await netEnv(8, (h) => Number(h.split('.')[3]) <= 3);
  try {
    for (let i = 0; i < 3; i++) await three.step();
    const a = three.to('rotem', 'probe_anomaly');
    assert.equal(a.length, 3);
    assert.ok(a.every((m) => /^חריגה בפרודקשן: tiki-bot-go\/net-vmi100[012]/.test(m.body)));
  } finally { await three.env.cleanup(); }
  const four = await netEnv(8, (h) => Number(h.split('.')[3]) <= 4);
  try {
    four.hq.probes.pingWitness = async (hosts) => new Map(hosts.map((h) => [h, parsePing(PING_OK)]));
    for (let i = 0; i < 3; i++) await four.step();
    const a = four.to('rotem', 'probe_anomaly');
    assert.equal(a.length, 1);
    assert.match(a[0]!.body, /4 מתוך 8 נודים/);
  } finally { await four.env.cleanup(); }
});

test('latency rounds stay in step: a node a few seconds off joins the round of the others', async () => {
  const { env, hq, step } = await netEnv(4, () => false);
  try {
    await step();
    hq.store.db.prepare(`UPDATE probe_state SET last_run_at = last_run_at + 20000 WHERE probe_id = 'tiki-bot-go/net-vmi1001'`).run();
    await step();
    const at = hq.store.db.prepare(`SELECT DISTINCT last_run_at FROM probe_state WHERE probe_id LIKE '%net-vmi%'`).all();
    assert.equal(at.length, 1, 'one round, one time');
  } finally { await env.cleanup(); }
});

test('spec 5: 4 jitter samples a day for 3 days with an impact → a Contabo ticket draft; for 2 days → none', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': NODES(2) } });
  try {
    const { hq, clock } = env;
    const now = clock.now();
    const ins = hq.store.db.prepare(`INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts, jitter, loss_percent, avg_ms, mdev_ms) VALUES (?, 0, NULL, ?, NULL, ?, 1, 0, ?, ?)`);
    for (let d = 0; d < 3; d++) for (let k = 0; k < 4; k++) ins.run('tiki-bot-go/net-vmi1000', 50 + d * 10 + k, now - d * 86_400_000 - (k + 1) * 3_600_000, 50 + d * 10 + k, 30 + k);
    // The service failed a minute after one of vmi1000's jitter samples: an impact.
    hq.store.db.prepare(`INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts) VALUES ('tiki-bot-go/api', 0, 503, 40, 'status 503', ?)`).run(now - 86_400_000 - 3_600_000 + 60_000);
    for (let d = 0; d < 2; d++) for (let k = 0; k < 4; k++) ins.run('tiki-bot-go/net-vmi1001', 40, now - d * 86_400_000 - (k + 1) * 3_600_000, 40, 25);
    const body = jitterDigest(hq.store.db, hq.probes.probes, now)!;
    assert.match(body, /tiki-bot-go\/net-vmi1000 \(10\.0\.0\.1\): jitter 4, אובדן 0, avg מקסימלי 53ms/);
    assert.match(body, /tiki-bot-go\/net-vmi1001 \(10\.0\.0\.2\): jitter 4/);
    assert.match(body, /vmi1000 \(10\.0\.0\.1\), 3 ימים ברצף\. השפעה בזמן ה-jitter: tiki-bot-go\/api נכשל פעם אחת\./);
    assert.match(body, /עם השפעה: המלצה לטיקט ב-Contabo/);
    assert.doesNotMatch(body, /למעקב/);
    assert.match(body, /Subject: Recurring network jitter on vmi1000 \(10\.0\.0\.1\)/);
    assert.match(body, /- 24h to 20\/10: 4 samples/);
    assert.match(body, /The worst samples:\n- 2026-10-18 05:00 UTC: avg 73ms, mdev 33ms\n- 2026-10-18 06:00 UTC: avg 72ms/, 'the worst samples, with time in UTC');
    assert.doesNotMatch(body, /vmi1001 \(10\.0\.0\.2\), \d ימים ברצף/, 'two days is not chronic');
    // Through the runner: once a day, from 06:00 Israel time, to רותם, `later`.
    hq.probes.run = async (p) => p.kind === 'http' ? { ok: true, status: 200, latencyMs: 1, error: null } : runLatencyProbe(p, async () => PING_OK);
    await hq.probes.tick();
    clock.advance(60_000);
    await hq.probes.tick();
    const d = hq.store.db.prepare(`SELECT priority, body FROM messages WHERE to_identity = 'rotem' AND body LIKE 'סיכום jitter יומי%'`).all() as { priority: string }[];
    assert.equal(d.length, 1);
    assert.equal(d[0]!.priority, 'later');
  } finally { await env.cleanup(); }
});

test('spec 5: chronic jitter without an impact is "למעקב", with no ticket and no draft; a node not Ready at the time is an impact', async () => {
  const charter = NODES(2).replace('\n```\n', '\n  - {id: cluster, cluster: root@10.0.0.100, every: 5m}\n```\n');
  const env = await makeEnv({ projects: { 'tiki-bot-go': charter } });
  try {
    const { hq, clock } = env;
    const now = clock.now();
    const ins = hq.store.db.prepare(`INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts, jitter, loss_percent, avg_ms, mdev_ms) VALUES (?, 0, NULL, 50, NULL, ?, 1, 0, 50, 30)`);
    for (const id of ['net-vmi1000', 'net-vmi1001']) for (let d = 0; d < 3; d++) for (let k = 0; k < 4; k++) ins.run(`tiki-bot-go/${id}`, now - d * 86_400_000 - (k + 1) * 3_600_000);
    // A service failure far from any jitter sample is not an impact; vmi1001 was not Ready while it jittered (and vmi1000 Ready).
    hq.store.db.prepare(`INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts) VALUES ('tiki-bot-go/api', 0, 503, 40, 'status 503', ?)`).run(now - 12 * 3_600_000);
    const rs = hq.store.db.prepare(`INSERT INTO root_samples (cluster, key, ts, value) VALUES ('tiki-bot-go/cluster', ?, ?, ?)`);
    rs.run('ready:vmi1000', now - 3_600_000, 1);
    rs.run('ready:vmi1001', now - 2 * 3_600_000 + 60_000, 0);
    const body = jitterDigest(hq.store.db, hq.probes.probes, now)!;
    assert.match(body, /למעקב: jitter קבוע בלי השפעה\. אין המלצה לטיקט\.\n- vmi1000 \(10\.0\.0\.1\), 3 ימים ברצף, בלי כשל שירות ובלי נוד לא Ready/);
    assert.doesNotMatch(body, /Recurring network jitter on vmi1000/, 'no draft for a node without an impact');
    assert.match(body, /vmi1001 \(10\.0\.0\.2\), 3 ימים ברצף\. השפעה בזמן ה-jitter: הנוד vmi1001 לא Ready \(tiki-bot-go\/cluster\) פעם אחת\./);
    assert.match(body, /Subject: Recurring network jitter on vmi1001/);
  } finally { await env.cleanup(); }
});

test('backfill: rows from before v32 get jitter/loss/avg/mdev from their error text, by the jitterOnly rule; idempotent', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': NODES(2) } });
  try {
    const { hq, clock } = env;
    const now = clock.now();
    const p = hq.probes.probes.find((x) => x.key === 'tiki-bot-go/net-vmi1000')!;
    // The error texts come from the probe itself, so a change in its wording breaks this test, not the backfill silently.
    const err = async (out: string) => (await runLatencyProbe(p, async () => out)).error!;
    const jit = await err('20 packets transmitted, 20 received, 0% packet loss, time 3901ms\nrtt min/avg/max/mdev = 0.469/22.485/83.042/28.411 ms\n');
    const small = await err('20 packets transmitted, 19 received, 5% packet loss, time 3901ms\nrtt min/avg/max/mdev = 0.4/30.5/90/25 ms\n');
    const busybox = await err('20 packets transmitted, 20 received, 0% packet loss\nround-trip min/avg/max = 0.4/30.5/90 ms\n');
    const lost = await err(lossOut(20));
    const none = await err('20 packets transmitted, 0 received, 100% packet loss, time 3901ms\n');
    const ins = hq.store.db.prepare('INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts) VALUES (?, ?, NULL, ?, ?, ?)');
    const rows = [[0, 22, jit], [0, 31, small], [0, 31, busybox], [0, 0, lost], [0, null, none], [1, 1, null], [0, null, 'פלט ping לא מובן: x']] as const;
    rows.forEach(([ok, lat, e], i) => ins.run('tiki-bot-go/net-vmi1000', ok, lat, e, now - (i + 1) * 60_000));
    ins.run('tiki-bot-go/api', 0, 5, jit, now - 60_000); // not a latency probe: untouched
    assert.equal(backfillLatencyRows(hq.store.db, hq.probes.probes), 5);
    const got = hq.store.db.prepare(`SELECT jitter, loss_percent, avg_ms, mdev_ms FROM probe_results WHERE probe_id = 'tiki-bot-go/net-vmi1000' ORDER BY ts DESC`).all()
      .map((r) => ({ ...r as object }));
    assert.deepEqual(got, [
      { jitter: 1, loss_percent: 0, avg_ms: 22.485, mdev_ms: 28.411 },
      { jitter: 1, loss_percent: 5, avg_ms: 30.5, mdev_ms: 25 },
      { jitter: 1, loss_percent: 0, avg_ms: 30.5, mdev_ms: null },
      { jitter: 0, loss_percent: 20, avg_ms: 0.4, mdev_ms: 0.1 },
      { jitter: 0, loss_percent: 100, avg_ms: null, mdev_ms: null },
      { jitter: 0, loss_percent: null, avg_ms: null, mdev_ms: null },
      { jitter: 0, loss_percent: null, avg_ms: null, mdev_ms: null },
    ]);
    assert.equal((hq.store.db.prepare(`SELECT loss_percent FROM probe_results WHERE probe_id = 'tiki-bot-go/api'`).get() as { loss_percent: number | null }).loss_percent, null);
    assert.equal(backfillLatencyRows(hq.store.db, hq.probes.probes), 0, 'a second run changes nothing');
    const body = jitterDigest(hq.store.db, hq.probes.probes, now)!;
    assert.match(body, /tiki-bot-go\/net-vmi1000 \(10\.0\.0\.1\): jitter 3, אובדן 2, avg מקסימלי 30\.5ms/);
    assert.equal(parsePingEvidence('status 500, expected 200'), null);
    // reload() runs it: a row written after the last reload is filled on the next one.
    ins.run('tiki-bot-go/net-vmi1001', 0, 22, jit.replace('10.0.0.1', '10.0.0.2'), now - 60_000);
    hq.probes.reload();
    assert.equal((hq.store.db.prepare(`SELECT jitter FROM probe_results WHERE probe_id = 'tiki-bot-go/net-vmi1001'`).get() as { jitter: number }).jitter, 1);
  } finally { await env.cleanup(); }
});

test('sshPingWitness: all hosts in one ssh, a summary per host; ssh failure or nothing readable = unavailable', async () => {
  const calls: string[][] = [];
  const mk = (out: string | Error) => sshPingWitness({ ssh: 'root@ci-host', identityFile: '/k' }, async (args) => { calls.push(args); if (out instanceof Error) throw out; return out; });
  const r = await mk(`@@ 10.0.0.1\n${PING_OK}@@ 10.0.0.2\n${lossOut(20)}@@ 10.0.0.3\nping: sendmsg: Network is unreachable\n`)(['10.0.0.1', '10.0.0.2', '10.0.0.3', '-x'], 20_000);
  assert.ok(r instanceof Map);
  assert.equal(r.get('10.0.0.1')!.lossPercent, 0);
  assert.equal(r.get('10.0.0.2')!.lossPercent, 20);
  assert.equal(r.get('10.0.0.3'), null);
  const cmd = calls[0]!.join(' ');
  assert.match(cmd, /-i \/k root@ci-host for h in '10\.0\.0\.1' '10\.0\.0\.2' '10\.0\.0\.3'; do/);
  assert.doesNotMatch(cmd, /-x/, 'a host that could be an option never reaches the shell');
  assert.match(cmd, /ping -c 20 -i 0\.2 -W 2 -q -- "\$h"/);
  assert.ok('unavailable' in (await mk(new Error('ssh exit 255'))(['10.0.0.1'], 20_000)));
  assert.ok('unavailable' in (await mk('garbage')(['10.0.0.1'], 20_000)));
});

test('shared event: a restart continues it, and the owner\'s item still closes when it ends', async () => {
  const { env, hq, step, to } = await netEnv(8, (h, r) => r < 2 && Number(h.split('.')[3]) <= 6, () => false);
  try {
    hq.probes.pingWitness = async () => ({ unavailable: 'ssh timeout' });
    await step(); await step();
    assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 1);
    // hq restarts: a new runner over the same store.
    const fresh = new ProbeRunner(hq.store, env.cfg, hq.mailbox, hq.inbox);
    fresh.probes = hq.probes.probes;
    fresh.run = hq.probes.run;
    fresh.host = hq.probes.host;
    await fresh.tick();
    assert.equal(to('rotem', 'probe_anomaly').filter((m) => /נפילה משותפת ברשת:/.test(m.body)).length, 1, 'not opened a second time');
    assert.ok(to('owner').some((m) => /חזר לתקין/.test(m.body)));
    assert.equal(hq.inbox.open().filter((i) => i.kind === 'incident').length, 0);
  } finally { await env.cleanup(); }
});

test('shared event: a node that starts losing after it was reported is told to רותם', async () => {
  const { env, hq, step, to } = await netEnv(8, (h, r) => Number(h.split('.')[3]) <= (r === 0 ? 4 : 5));
  try {
    hq.probes.pingWitness = async (hosts) => new Map(hosts.map((h) => [h, parsePing(PING_OK)]));
    await step(); await step(); await step();
    const j = to('rotem', 'system').filter((m) => /הצטרפו לנפילה המשותפת/.test(m.body));
    assert.equal(j.length, 1);
    assert.match(j[0]!.body, /net-vmi1004 \(10\.0\.0\.5\): אובדן 20%/);
  } finally { await env.cleanup(); }
});

test('spec 7: 5 jitter samples in a row send nothing; 6 without an impact are noted quietly, wake no one and send no "recovered"', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': LATENCY } });
  try {
    const { hq, clock } = env;
    hq.probes.probes = hq.probes.probes.filter((p) => p.id === 'net-vmi1000011');
    const seq = [...Array(5).fill(PING_JITTER), PING_OK, ...Array(5).fill(PING_JITTER), PING_LOSS, PING_JITTER, PING_JITTER, PING_OK];
    hq.probes.run = (p) => runLatencyProbe(p, async () => seq.shift()!);
    const anomalies = () => hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string }[];
    const step = async () => { await hq.probes.tick(); clock.advance(ROUND); };
    for (let i = 0; i < 5; i++) await step();
    assert.equal(anomalies().length, 0, 'five in a row: nothing');
    await step(); // clean: the count starts over
    for (let i = 0; i < 5; i++) await step();
    assert.equal(anomalies().length, 0, 'five again after a clean one: nothing');
    const quiet = () => (hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'probe.jitter_quiet'`).get() as { n: number }).n;
    await step(); // a loss sample continues the run: the sixth, and no service failed and no node was not Ready
    assert.equal(anomalies().length, 0, 'jitter without an impact wakes no one');
    assert.equal(quiet(), 1, 'noted quietly');
    await step(); await step(); // jitter goes on: still nothing, noted once
    assert.equal(anomalies().length, 0);
    assert.equal(quiet(), 1);
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE body NOT LIKE 'סיכום jitter יומי%'`).get() as { n: number }).n, 0, 'nothing to anyone (but the daily digest)');
    await step(); // clean
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE body LIKE '%חזר לתקין%'`).get() as { n: number }).n, 0, 'no "recovered" without an alert');
  } finally { await env.cleanup(); }
});

test('spec 7: sustained jitter with a service failing in its project in the window opens one urgent anomaly, with the impact', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': NODES(1) } });
  try {
    const { hq, clock } = env;
    let round = 0;
    // The service fails once, in the fourth round: under its fail_after, so it is only the jitter's impact.
    hq.probes.run = (p) => p.kind === 'http'
      ? Promise.resolve(round === 3 ? { ok: false, status: 503, latencyMs: 40, error: 'status 503, expected 200' } : { ok: true, status: 200, latencyMs: 40, error: null })
      : runLatencyProbe(p, async () => round < 8 ? PING_JITTER : PING_OK);
    hq.probes.host = () => ({ load1: 0.5, cpus: 8, freeMb: 9000 });
    const step = async () => { await hq.probes.tick(); round++; clock.advance(ROUND); };
    const anomalies = () => hq.store.db.prepare(`SELECT body, urgency FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string; urgency: string }[];
    for (let i = 0; i < 5; i++) await step();
    assert.equal(anomalies().length, 0);
    await step(); // the sixth
    assert.equal(anomalies().length, 1);
    assert.equal(anomalies()[0]!.urgency, 'urgent');
    assert.match(anomalies()[0]!.body, /jitter מתמשך עם השפעה: 6 דגימות ברצף בלי דגימה תקינה/);
    assert.match(anomalies()[0]!.body, /השפעה בזמן ה-jitter: tiki-bot-go\/api נכשל פעם אחת\./);
    assert.equal((anomalies()[0]!.body.match(/^- \d{4}-/gm) ?? []).length, 6, 'the six samples as evidence');
    await step(); await step(); // jitter goes on: still one, and not "recovered"
    assert.equal(anomalies().length, 1);
    const recovered = () => (hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'system' AND body LIKE '%net-vmi1000 חזר לתקין%'`).all() as unknown[]).length;
    assert.equal(recovered(), 0);
    await step(); // clean
    assert.equal(recovered(), 1);
  } finally { await env.cleanup(); }
});

test('spec 7: a service failing in the round before the run, or healthy all along, is no impact; a node not Ready in the run is one', async () => {
  const charter = NODES(1).replace('\n```\n', '\n  - {id: cluster, cluster: root@10.0.0.100, every: 5m}\n```\n');
  const env = await makeEnv({ projects: { 'tiki-bot-go': charter } });
  try {
    const { hq, clock } = env;
    hq.probes.roots.collect = async () => { throw new Error('no ssh in tests'); };
    let round = 0;
    // Round 0: clean ping, the service fails. Rounds 1–6: jitter, the service fine. Round 7 on: jitter, and the node not Ready.
    hq.probes.run = (p) => p.kind === 'http'
      ? Promise.resolve(round === 0 ? { ok: false, status: 503, latencyMs: 40, error: 'status 503, expected 200' } : { ok: true, status: 200, latencyMs: 40, error: null })
      : runLatencyProbe(p, async () => round === 0 ? PING_OK : PING_JITTER);
    hq.probes.host = () => ({ load1: 0.5, cpus: 8, freeMb: 9000 });
    const step = async () => { await hq.probes.tick(); round++; clock.advance(ROUND); };
    const anomalies = () => hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly' AND body LIKE '%jitter מתמשך%'`).all() as { body: string }[];
    for (let i = 0; i < 7; i++) await step(); // the sixth jitter sample is round 6
    assert.equal(anomalies().length, 0, 'the failure was before the run, and the service was fine during it');
    hq.store.db.prepare(`INSERT INTO root_samples (cluster, key, ts, value) VALUES ('tiki-bot-go/cluster', 'ready:vmi1000', ?, 0)`).run(clock.now() - 30_000);
    await step();
    assert.equal(anomalies().length, 1);
    assert.match(anomalies()[0]!.body, /השפעה בזמן ה-jitter: הנוד vmi1000 לא Ready \(tiki-bot-go\/cluster\) פעם אחת\./);
  } finally { await env.cleanup(); }
});

test('spec 7: jitter that a shared event joins opens no anomaly per node, and the event\'s loss doesn\'t count after it ends', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': NODES(6) } });
  try {
    const { hq, clock } = env;
    let round = 0;
    // The service fails once, in the round of the sixth sample after the event: the jitter's impact (and under fail_after).
    hq.probes.run = (p) => p.kind === 'http' ? Promise.resolve(round === 12 ? { ok: false, status: 503, latencyMs: 40, error: 'status 503, expected 200' } : { ok: true, status: 200, latencyMs: 40, error: null })
      : runLatencyProbe(p, async () => round === 5 || round === 6 ? lossOut(20) : PING_JITTER);
    hq.probes.host = () => ({ load1: 0.5, cpus: 8, freeMb: 9000 });
    const step = async () => { await hq.probes.tick(); round++; clock.advance(ROUND); };
    const sustained = () => (hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly' AND body LIKE '%jitter מתמשך%'`).all()).length;
    for (let i = 0; i < 7; i++) await step(); // 5 jitter, then two rounds of shared loss
    assert.equal(sustained(), 0, 'the shared event speaks for them');
    assert.equal((hq.store.db.prepare(`SELECT body FROM messages WHERE body LIKE 'נפילה משותפת ברשת:%'`).all()).length, 1);
    for (let i = 0; i < 5; i++) await step(); // jitter after the event ended: five samples of its own
    assert.equal(sustained(), 0, 'the event\'s loss is not jitter that lasted');
    await step(); // the sixth after the event
    assert.equal(sustained(), 6);
  } finally { await env.cleanup(); }
});

test('spec 7: jitter then loss up to fail_after is one loss anomaly; a gap in the samples starts the run over', async () => {
  const env = await makeEnv({ projects: { 'tiki-bot-go': NODES(1) } });
  try {
    const { hq, clock } = env;
    const seq = [PING_JITTER, PING_JITTER, PING_JITTER, lossOut(20), lossOut(20), lossOut(20)];
    hq.probes.probes = hq.probes.probes.filter((p) => p.kind === 'latency');
    hq.probes.run = (p) => runLatencyProbe(p, async () => seq.shift() ?? PING_JITTER);
    const anomalies = () => hq.store.db.prepare(`SELECT body FROM messages WHERE kind = 'probe_anomaly'`).all() as { body: string }[];
    for (let i = 0; i < 6; i++) { await hq.probes.tick(); clock.advance(ROUND); }
    assert.equal(anomalies().length, 1);
    assert.match(anomalies()[0]!.body, /3 כישלונות ברצף/);
    assert.doesNotMatch(anomalies()[0]!.body, /jitter מתמשך/);
  } finally { await env.cleanup(); }
  const env2 = await makeEnv({ projects: { 'tiki-bot-go': NODES(1) } });
  try {
    const { hq, clock } = env2;
    hq.probes.probes = hq.probes.probes.filter((p) => p.kind === 'latency');
    hq.probes.run = (p) => runLatencyProbe(p, async () => PING_JITTER);
    for (let i = 0; i < 5; i++) { await hq.probes.tick(); clock.advance(ROUND); }
    clock.advance(60 * 60_000); // hq was down for an hour
    await hq.probes.tick();
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE kind = 'probe_anomaly'`).get() as { n: number }).n, 0);
  } finally { await env2.cleanup(); }
});

const CLUSTER = '```yaml\nprobes:\n  - {id: kubelet-versions, kubelet: root@203.0.113.13, every: 30m}\n  - {id: bad, kubelet: "-oProxyCommand=x"}\n  - {id: bad2, kubelet: "-Elog@host"}\n```\n';
const kubectlOut = (master: string, nodes: Record<string, string>) =>
  `{"major":"1","gitVersion":"${master}"}\n@@nodes\n${Object.entries(nodes).map(([n, v]) => `${n} ${v}`).join('\n')}\n`;

test('kubelet probe: parsing, the apiserver version against each node; ssh error or garbage = unknown', async () => {
  const [k, bad, bad2] = parseCharterProbes('cluster', CLUSTER);
  assert.deepEqual([k!.kind, bad!.kind, bad2!.kind], ['kubelet', 'unsupported', 'unsupported'], 'a target that ssh would read as an option is not a probe');
  assert.equal(k!.kubelet!.target, 'root@203.0.113.13');
  assert.equal(k!.everyMs, 30 * 60_000);
  assert.equal(parseKubeletVersions('garbage'), null);
  assert.equal(parseKubeletVersions('{"gitVersion":"v1.33.6+k3s1"}\n@@nodes\n'), null, 'no nodes is no answer');
  assert.deepEqual(parseKubeletVersions('{"gitVersion":"v1"}\n@@nodes\na v1\nnew\n')!.nodes, { a: 'v1', new: '' }, 'a node still registering has no version');
  assert.equal((await runKubeletProbe(k!, async () => kubectlOut('v1', { a: 'v1' }) + 'new\n')).ok, true, 'no version is not a skew');
  const calls: string[][] = [];
  const mk = (out: string | Error) => async (args: string[]) => { calls.push(args); if (out instanceof Error) throw out; return out; };
  const same = await runKubeletProbe(k!, mk(kubectlOut('v1.33.6+k3s1', { srv: 'v1.33.6+k3s1', vmi1: 'v1.33.6+k3s1' })));
  assert.equal(same.ok, true);
  assert.match(calls[0]!.join(' '), /root@203\.0\.113\.13 kubectl get --raw \/version && echo @@nodes && kubectl get nodes -o jsonpath=/);
  const off = await runKubeletProbe(k!, mk(kubectlOut('v1.33.6+k3s1', { srv: 'v1.33.6+k3s1', vmi1: 'v1.34.3+k3s1' })));
  assert.equal(off.ok, false);
  assert.equal(off.unknown, undefined);
  assert.match(off.error!, /vmi1 v1\.34\.3\+k3s1/);
  for (const o of [new Error('ssh exit 255'), '', 'The connection to the server was refused']) assert.equal((await runKubeletProbe(k!, mk(o))).unknown, true, String(o));
});

test('kubelet probe: one anomaly per node until it matches the master again, one note then; unknown changes nothing', async () => {
  const env = await makeEnv({ projects: { cluster: CLUSTER } });
  try {
    const { hq, clock } = env;
    const M = 'v1.33.6+k3s1', N = 'v1.34.3+k3s1';
    const seq: Array<Record<string, string> | 'unknown'> = [
      { srv: M, a: M, b: N, c: N },
      { srv: M, a: M, b: N, c: N },   // same skew: nothing new
      'unknown',
      { srv: M, a: M, b: '', c: N },  // b has no version this time: still open, no note
      { srv: M, a: N, b: N, c: M },   // a goes off, c back
      { srv: M, a: N },               // b gone from the cluster
      { srv: M, a: M },
    ];
    hq.probes.run = async () => {
      const v = seq.shift()!;
      if (v === 'unknown') return { ok: false, unknown: true, status: null, latencyMs: 5, error: 'ssh timeout' };
      const off = Object.values(v).some((x) => x !== M);
      return { ok: !off, versions: { master: M, nodes: v }, status: null, latencyMs: 5, error: off ? 'skew' : null };
    };
    const msgs = (kind: string) => (hq.store.db.prepare(`SELECT body, urgency FROM messages WHERE to_identity = 'rotem' AND kind = ? ORDER BY created_at, rowid`).all(kind) as { body: string; urgency: string }[]);
    const open = () => (hq.store.db.prepare(`SELECT anomaly_open n FROM probe_state WHERE probe_id = 'cluster/kubelet-versions'`).get() as { n: number }).n;
    const step = async () => { await hq.probes.tick(); clock.advance(30 * 60_000 + 1000); };
    await step();
    assert.equal(msgs('probe_anomaly').length, 1, 'nodes off in the same reading share one message');
    assert.match(msgs('probe_anomaly')[0]!.body, /2 נודים מריצים kubelet בגרסה אחרת מהמאסטר \(apiserver v1\.33\.6\+k3s1\)/);
    assert.match(msgs('probe_anomaly')[0]!.body, /הנוד b מריץ kubelet v1\.34\.3\+k3s1\n- הנוד c מריץ kubelet v1\.34\.3\+k3s1/);
    assert.equal(msgs('probe_anomaly')[0]!.urgency, 'normal', 'a skew is fixed by day, it wakes no one');
    assert.equal(open(), 1);
    await step(); await step(); await step();
    assert.equal(msgs('probe_anomaly').length, 1, 'no flood: the same skew, an unknown and a node without a version send nothing');
    assert.equal(msgs('system').length, 0);
    await step();
    assert.equal(msgs('probe_anomaly').length, 2);
    assert.match(msgs('probe_anomaly')[1]!.body, /נוד מריץ kubelet.*\n- הנוד a /);
    assert.match(msgs('system').at(-1)!.body, /c חזר לגרסה של המאסטר/);
    await step();
    assert.match(msgs('system').at(-1)!.body, /b כבר לא בקלאסטר/);
    assert.equal(open(), 1);
    await step();
    assert.match(msgs('system').at(-1)!.body, /a חזר לגרסה של המאסטר/);
    assert.equal(open(), 0);
    assert.equal(msgs('probe_anomaly').length, 2);
  } finally { await env.cleanup(); }
});

const FAIL_FOR = `# lumo

\`\`\`yaml
probes:
  - {id: e2e, http: https://e2e.lumo.test/healthz, every: 1m, expect: 200, fail_after: 3, fail_for: 30s}
  - {id: api, http: https://api.lumo.test/v0/channels, every: 1m, expect: 403, fail_after: 3}
\`\`\`
`;

test('fail_for: parsed for http; on another kind or not a duration the probe is unsupported', () => {
  const [e2e, api] = parseCharterProbes('lumo', FAIL_FOR);
  assert.equal(e2e!.failForMs, 30_000);
  assert.equal(e2e!.kind, 'http');
  assert.equal(api!.failForMs, null);
  const bad = parseCharterProbes('x', `\`\`\`yaml\nprobes:\n  - {id: d, disk: 'local:/', max_percent: 80, fail_for: 30s}\n  - {id: h, http: https://h.test, fail_for: soon}\n  - {id: z, http: https://h.test, fail_for: 0s}\n\`\`\`\n`);
  assert.deepEqual(bad.map((p) => p.kind), ['unsupported', 'unsupported', 'unsupported']);
});

test('http probe: a timeout, a refused connection, a name that does not exist (NXDOMAIN) or a status is an answer; only EAI_AGAIN is noAnswer', async () => {
  const srv = createServer((req, res) => { if (req.url === '/hang') return; res.writeHead(503); res.end('x'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const mk = (u: string) => parseCharterProbes('x', `\`\`\`yaml\nprobes:\n  - {id: h, http: '${u}', timeout: 300ms, fail_for: 30s}\n\`\`\`\n`)[0]!;
    const hang = await runHttpProbe(mk(`${url}/hang`));
    assert.equal(hang.ok, false);
    assert.equal(hang.noAnswer, undefined, 'a timeout starts fail_for like a status');
    const dns = await runHttpProbe(mk('http://nothing-here.invalid/'));
    assert.equal(dns.ok, false);
    if (/ENOTFOUND/.test(dns.error!)) assert.equal(dns.noAnswer, undefined, 'the DNS answered: no such name');
    else assert.match(dns.error!, /EAI_AGAIN/, 'a resolver that did not answer (no DNS where the test runs)');
    const status = await runHttpProbe(mk(`${url}/x`));
    assert.equal(status.status, 503);
    assert.equal(status.noAnswer, undefined);
    const refused = await runHttpProbe(mk('http://127.0.0.1:1/'));
    assert.equal(refused.ok, false);
    assert.equal(refused.noAnswer, undefined);
  } finally { srv.closeAllConnections(); srv.close(); }
});

/** Drive the runner in 5s ticks (hq's cadence) for `ms`, with the e2e probe failing as `fail(t)` says (t = ms since the start). */
async function failFor(fail: (t: number) => false | 'answer' | 'timeout' | 'noAnswer' | 'unknown', ms: number, witnessOk = false) {
  const env = await makeEnv({ projects: { lumo: FAIL_FOR } });
  const { hq, clock } = env;
  const t0 = hq.store.now();
  const runs: number[] = [];
  const asked: number[] = [];
  hq.probes.run = async (p) => {
    if (p.id !== 'e2e') return { ok: true, status: 403, latencyMs: 20, error: null };
    const t = hq.store.now() - t0;
    runs.push(t);
    const f = fail(t);
    if (!f) return { ok: true, status: 200, latencyMs: 20, error: null };
    if (f === 'unknown') return { ok: false, unknown: true, status: null, latencyMs: null, error: 'ssh timeout' };
    if (f === 'noAnswer') return { ok: false, noAnswer: true, status: null, latencyMs: 30, error: 'getaddrinfo EAI_AGAIN e2e.lumo.test (EAI_AGAIN)' };
    if (f === 'timeout') return { ok: false, status: null, latencyMs: 10_000, error: 'The operation was aborted due to timeout' };
    return { ok: false, status: 502, latencyMs: 30, error: 'status 502, expected 200' };
  };
  hq.probes.witness = async () => { asked.push(hq.store.now() - t0); return witnessOk ? { ok: true, status: 200, latencyMs: 40, error: null } : { ok: false, status: 502, latencyMs: 35, error: 'status 502, expected 200' }; };
  for (let t = 0; t <= ms; t += 5_000) { await hq.probes.tick(); clock.advance(5_000); }
  const msgs = hq.store.db.prepare(`SELECT kind, priority, body, created_at FROM messages WHERE to_identity = 'rotem' ORDER BY created_at`).all() as
    { kind: string; priority: string; body: string; created_at: number }[];
  return { env, runs, asked, anomalies: msgs.filter((m) => m.kind === 'probe_anomaly'), notes: msgs.filter((m) => /חזר לתקין/.test(m.body)), all: msgs };
}

test('fail_for: a failure that recovers after 20 seconds wakes no one; retries every 10s, then back to every', async () => {
  const r = await failFor((t) => t < 20_000 && 'answer', 180_000);
  try {
    assert.equal(r.anomalies.length, 0);
    assert.equal(r.asked.length, 0, 'no witness: nothing crossed');
    assert.equal(r.notes.length, 0, 'nothing was open, nothing to recover from');
    assert.deepEqual(r.runs, [0, 10_000, 20_000, 60_000, 120_000, 180_000], 'retries only while the failure is open, ended by the first success');
    assert.equal((r.env.hq.store.db.prepare(`SELECT consecutive_failures n FROM probe_state WHERE probe_id = 'lumo/e2e'`).get() as { n: number }).n, 0, 'the scheduled run at 60s passed');
  } finally { await r.env.cleanup(); }
});

test('fail_for: a failure that lasts 31 seconds wakes רותם once, before fail_after, after the witness; recovery = one note', async () => {
  const r = await failFor((t) => t <= 31_000 && 'answer', 240_000);
  try {
    assert.equal(r.anomalies.length, 1, 'once');
    assert.deepEqual(r.asked, [30_000], 'the witness is asked once, when it lasted 30s');
    const a = r.anomalies[0]!;
    assert.equal(a.priority, 'now');
    assert.match(a.body, /lumo\/e2e/);
    assert.match(a.body, /נכשל ברצף 30 שניות \(fail_for=30s/);
    assert.match(a.body, /אומת גם מנקודה שנייה: status=502/);
    assert.equal(a.body.match(/status=502 latency=30ms/g)!.length, 4, 'every failure since the first is evidence');
    assert.equal(r.notes.length, 1, 'one note');
    assert.match(r.notes[0]!.body, /lumo\/e2e חזר לתקין/);
    // While the anomaly is open the retries go on, so the note comes within 10s of the recovery; then back to `every`.
    assert.deepEqual(r.runs, [0, 10_000, 20_000, 30_000, 40_000, 60_000, 120_000, 180_000, 240_000]);
    assert.equal(r.notes[0]!.created_at - r.anomalies[0]!.created_at, 10_000);
  } finally { await r.env.cleanup(); }
});

test('fail_for: fine from ci-host → no anomaly, the retries stop, and the schedule goes on as with fail_after', async () => {
  const r = await failFor(() => 'answer', 150_000, true);
  try {
    assert.equal(r.anomalies.length, 0);
    assert.deepEqual(r.asked, [30_000, 60_000, 120_000], 'asked at 30s, then once per scheduled run');
    assert.deepEqual(r.runs, [0, 10_000, 20_000, 30_000, 60_000, 120_000]);
    assert.ok(r.all.some((m) => /אירוע על hq-host/.test(m.body)));
  } finally { await r.env.cleanup(); }
});

test('fail_for: a DNS that did not answer (EAI_AGAIN) does not start the clock or cross it; fail_after still does', async () => {
  const r = await failFor(() => 'noAnswer', 130_000);
  try {
    assert.deepEqual(r.runs, [0, 60_000, 120_000], 'no retries: no failure with an answer');
    assert.equal(r.anomalies.length, 1, 'fail_after (3) as before');
    assert.match(r.anomalies[0]!.body, /3 כישלונות ברצף \(fail_after=3\)/);
  } finally { await r.env.cleanup(); }
  // An answer starts it; the stretch of EAI_AGAIN after it is frozen (0→40s), so it crosses 30s of answered failures after that, at 70s.
  const m = await failFor((t) => t === 0 || t >= 40_000 ? 'answer' : 'noAnswer', 75_000);
  try {
    assert.deepEqual(m.asked, [70_000], 'not by the EAI_AGAIN at 30s, nor by the answer at 40s');
    assert.equal(m.anomalies.length, 1);
  } finally { await m.env.cleanup(); }
  // unknown (the probe could not ask) changes nothing.
  const u = await failFor((t) => t === 0 ? 'answer' : t < 40_000 ? 'unknown' : false, 60_000);
  try {
    assert.equal(u.anomalies.length, 0);
    assert.equal(u.asked.length, 0);
  } finally { await u.env.cleanup(); }
});

test('fail_for: timeouts in a row from 0 cross at 30s, through the witness once; recovery = one note', async () => {
  const r = await failFor((t) => t <= 31_000 && 'timeout', 240_000);
  try {
    assert.deepEqual(r.asked, [30_000], 'a server stuck altogether is crossed by fail_for, not fail_after');
    assert.equal(r.anomalies.length, 1);
    assert.match(r.anomalies[0]!.body, /נכשל ברצף 30 שניות \(fail_for=30s/);
    assert.deepEqual(r.runs, [0, 10_000, 20_000, 30_000, 40_000, 60_000, 120_000, 180_000, 240_000]);
    assert.equal(r.notes.length, 1, 'one note');
    assert.match(r.notes[0]!.body, /lumo\/e2e חזר לתקין/);
  } finally { await r.env.cleanup(); }
});

test('fail_for: removed from the charter during an open failure → its retries stop', async () => {
  const r = await failFor((t) => t < 200_000 && 'answer', 15_000);
  try {
    const { hq, clock } = r.env;
    const n = r.runs.length;
    writeFileSync(join(hq.cfg.companyDir, 'projects', 'lumo.md'), FAIL_FOR.replace(', fail_for: 30s', ''));
    hq.probes.reload();
    for (let t = 20_000; t <= 65_000; t += 5_000) { await hq.probes.tick(); clock.advance(5_000); }
    assert.deepEqual(r.runs.slice(n), [60_000], 'only the scheduled run');
  } finally { await r.env.cleanup(); }
});

test('fail_for: a flapping service (scheduled runs fail, the retry after each passes) still reaches fail_after', async () => {
  const r = await failFor((t) => t % 60_000 === 0 && 'answer', 125_000);
  try {
    assert.deepEqual(r.runs, [0, 10_000, 60_000, 70_000, 120_000, 130_000].filter((t) => t <= 125_000));
    assert.equal(r.anomalies.length, 1, 'three scheduled failures in a row, as before fail_for');
    assert.match(r.anomalies[0]!.body, /3 כישלונות ברצף \(fail_after=3\)/);
  } finally { await r.env.cleanup(); }
});
