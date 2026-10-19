import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeEnv } from './helpers.ts';
import { parseCharterProbes, parseDuration, runHttpProbe } from '../src/probes.ts';

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
