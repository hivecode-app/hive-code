import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { makeEnv, until } from './helpers.ts';
import { loadProbes, parseCharterProbes, parseDuration, runHttpProbe } from '../src/probes.ts';

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
