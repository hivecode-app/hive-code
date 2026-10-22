import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { makeEnv, until } from './helpers.ts';
import { loadProbes, parseCharterProbes, parseDuration, runHttpProbe, runDiskProbe, sshWitness } from '../src/probes.ts';

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
