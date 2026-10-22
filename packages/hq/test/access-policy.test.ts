import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeResource, matchPattern, parseCatalog, planAccess, planKube, planQuery, planSsh, redact, type KubeResource, type SshResource } from '../src/access-policy.ts';

const dev: KubeResource = { type: 'kube', namespace: 'lumo-dev', kubeconfig: '/k/dev.yaml', env: 'dev' };
const plan = (argv: string[], res: KubeResource = dev) => planKube(res, argv);
const ok = (argv: string[]) => {
  const v = plan(argv);
  assert.ok(v.ok, `${argv.join(' ')} → ${v.ok ? '' : v.why}`);
  return v.plan;
};
const bad = (argv: string[], kind: 'unfit' | 'deny') => {
  const v = plan(argv);
  assert.ok(!v.ok, `${argv.join(' ')} should be refused`);
  assert.equal(v.kind, kind, `${argv.join(' ')}: ${v.why}`);
  return v;
};

test('kube: the allowed reads become kubectl with the catalog\'s kubeconfig and namespace', () => {
  const p = ok(['get', 'pods', '-o', 'wide']);
  assert.deepEqual(p, { kind: 'process', cmd: 'kubectl', args: ['--kubeconfig', '/k/dev.yaml', '-n', 'lumo-dev', 'get', 'pods', '--output=wide'], class: 'read', shown: 'kubectl -n lumo-dev get pods -o wide' });
  ok(['get', 'deploy/api', '-o', 'json']);
  ok(['get', 'pods,svc', '-l', 'app=api']);
  ok(['describe', 'pod', 'api-7d9']);
  ok(['logs', 'deploy/api', '--tail=100', '--since=10m']);
  ok(['logs', 'api-7d9', '--tail', '50', '-c', 'api', '--previous']);
  ok(['rollout', 'status', 'deploy/api', '--timeout=5m']);
  ok(['rollout', 'history', 'deploy/api']);
  ok(['top', 'pods']);
  assert.equal(plan(['get', 'pods', '-n', 'lumo-dev']).ok, true, 'the resource\'s own namespace is fine');
  ok(['get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}']);
});

test('kube: writes and exec are classed, and built with the same fences', () => {
  assert.equal(ok(['rollout', 'restart', 'deploy/api']).class, 'write');
  assert.equal(ok(['set', 'image', 'deploy/api', 'api=ghcr.io/hive-owner/lumo:2.6.10']).class, 'write');
  assert.equal(ok(['scale', 'deploy/api', '--replicas=2']).class, 'write');
  assert.equal(ok(['delete', 'pod/api-7d9']).class, 'write');
  const e = ok(['exec', 'deploy/api', '--', 'ls', '/app']);
  assert.equal(e.class, 'exec');
  assert.deepEqual((e as { args: string[] }).args.slice(-5), ['exec', 'deploy/api', '--', 'ls', '/app']);
});

test('kube: --kubeconfig, --token, --as, another namespace and --server are refused for good, wherever they stand', () => {
  for (const argv of [
    ['get', 'pods', '--kubeconfig=/etc/other'], ['get', 'pods', '--kubeconfig', '/etc/other'], ['--token=abc', 'get', 'pods'], ['get', 'pods', '--as=admin'],
    ['get', 'pods', '--as-group', 'system:masters'], ['get', 'pods', '-n', 'lumo-prod'], ['get', 'pods', '--namespace=kube-system'], ['-n', 'lumo-prod', 'get', 'pods'],
    ['get', 'pods', '-A'], ['get', 'pods', '--all-namespaces'], ['get', 'pods', '--server', 'https://x'], ['get', 'pods', '--context', 'prod'],
    ['logs', 'api', '--tail=5', '--token', 'x'], ['exec', 'api', '--as=root', '--', 'id'], ['get', '--raw', '/api'],
  ]) bad(argv, 'deny');
});

test('kube: secrets, follow, port-forward, apply and interactive exec are unfit, with a way out', () => {
  assert.match(bad(['get', 'secret', 'db'], 'unfit').why, /secrets/);
  bad(['get', 'secrets', '-o', 'yaml'], 'unfit');
  bad(['get', 'secret/db'], 'unfit');
  bad(['get', 'configmaps'], 'unfit');
  bad(['get', 'all'], 'unfit');
  assert.match(bad(['logs', 'api', '-f'], 'unfit').hint ?? '', /--tail/);
  assert.match(bad(['logs', 'api', '--follow', '--tail=3'], 'unfit').hint ?? '', /--tail/);
  bad(['logs', 'api'], 'unfit');
  assert.ok(bad(['port-forward', 'svc/api', '8080'], 'unfit').hint);
  assert.match(bad(['apply', '-f', 'x.yaml'], 'unfit').hint ?? '', /set image/);
  bad(['exec', '-it', 'api', '--', 'sh'], 'unfit');
  bad(['exec', 'api'], 'unfit');
  bad(['get', 'pods', '-w'], 'unfit');
  bad(['get', 'pods', '-o', 'go-template={{.}}'], 'unfit');
  bad(['get', 'pods', '--unknown-flag'], 'unfit');
  bad(['delete', 'deploy/api'], 'unfit');
  bad(['delete', 'pods', '--all'], 'unfit');
  bad(['rollout', 'pause', 'deploy/api'], 'unfit');
  bad(['set', 'env', 'deploy/api', 'A=b'], 'unfit');
  bad(['scale', 'deploy/api'], 'unfit');
  bad(['get', 'pods', 'a', 'b'], 'unfit');
  bad(['get', 'pod/a', 'b'], 'unfit');
  bad(['cp', 'a', 'b'], 'unfit');
  bad([], 'unfit');
  bad(['get', 'pod;rm'], 'unfit');
});

test('ssh: only what the catalog lists, with words in the safe charset', () => {
  const res: SshResource = { type: 'ssh', host: '203.0.113.11', user: 'root', key: '/k/ci-host', env: 'ci', allow: [
    { argv: ['docker', 'images'] }, { argv: ['docker', 'push', 'ghcr.io/hive-owner/*'], class: 'write' }, { argv: ['/opt/ci/build.sh', '**'], class: 'write' }] };
  const v = planSsh(res, ['docker', 'push', 'ghcr.io/hive-owner/lumo:2.6.10']);
  assert.ok(v.ok);
  if (v.ok && v.plan.kind === 'process') {
    assert.equal(v.plan.class, 'write');
    assert.deepEqual(v.plan.args.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
    assert.deepEqual(v.plan.args.slice(-5), ['root@203.0.113.11', '--', 'docker', 'push', 'ghcr.io/hive-owner/lumo:2.6.10']);
    assert.ok(v.plan.args.includes('/k/ci-host'));
  }
  assert.ok(planSsh(res, ['/opt/ci/build.sh', 'lumo', '2.6.10']).ok);
  assert.equal((planSsh(res, ['docker', 'images']) as { plan: { class: string } }).plan.class, 'read');
  for (const argv of [['docker', 'ps'], ['docker', 'images', '-a'], ['rm', '-rf', '/'], ['docker', 'images;', 'id'], ['docker', 'images', '$(id)'], ['docker', 'images', '|', 'sh'], ['cat', '/etc/passwd']]) {
    const x = planSsh(res, argv);
    assert.ok(!x.ok && x.kind === 'unfit', argv.join(' '));
  }
  assert.ok(!planSsh({ ...res, allow: [] }, ['docker', 'images']).ok);
});

test('matchPattern: a literal, * for one word, ** for the rest', () => {
  assert.ok(matchPattern(['a', '*'], ['a', 'x']));
  assert.ok(!matchPattern(['a', '*'], ['a']));
  assert.ok(!matchPattern(['a', '*'], ['a', 'x', 'y']));
  assert.ok(matchPattern(['a', '**'], ['a']));
  assert.ok(matchPattern(['a', '**'], ['a', 'x', 'y']));
  assert.ok(!matchPattern(['a'], ['b']));
  assert.ok(!matchPattern(['tail', '*'], ['tail', '-f']), 'a star is not a flag');
  assert.ok(!matchPattern(['cat', '/var/log/app/*'], ['cat', '/var/log/app/../../etc/shadow']), 'nor a way up');
  assert.ok(matchPattern(['logs', '*', '--tail=*'], ['logs', 'api-1', '--tail=50']), 'a flag the pattern names may carry a star');
  assert.ok(!matchPattern(['logs', '*', '--tail=*'], ['logs', 'api-1', '--since=1h']));
  assert.ok(!matchPattern(['logs', '*', '--tail=*'], ['logs', 'api-1', '--tail=50', '-f']));
  assert.ok(!matchPattern(['ls', '--dir=*'], ['ls', '--dir=a/../../etc']), 'still no way up');
  assert.ok(!matchPattern(['ls', '--dir=*'], ['ls', '--dir=../etc']), 'nor right after the =');
  assert.ok(!matchPattern(['ls', '--dir=*'], ['ls', '--dir=..']));
  assert.ok(!matchPattern(['dd', 'if=*'], ['dd', 'if=../etc']));
  assert.ok(!matchPattern(['curl', '--data=*'], ['curl', '--data=@../secret']));
  assert.ok(!matchPattern(['ls', '--dir=*'], ['ls', '--dir=a,../etc']));
  assert.ok(!matchPattern(['ls', '-n*'], ['ls', '-nf']), 'a short flag with a star would let others in');
  assert.ok(!matchPattern(['docker', 'logs', '**'], ['docker', 'logs', '--follow', 'x']));
  assert.ok(matchPattern(['docker', 'logs', '-f', '*'], ['docker', 'logs', '-f', 'api']), 'a flag named in the pattern is allowed');
});

test('hq:query: one SELECT, no writes, none of the tables with tokens', () => {
  assert.ok(planQuery(['select count(*) from tasks;']).ok);
  assert.ok(planQuery(['WITH x AS (SELECT 1) SELECT * FROM x']).ok);
  for (const q of ['delete from tasks', 'select 1; select 2', 'pragma table_info(tasks)', 'select * from devices', 'select * from passkeys', 'select * from accounts', 'update tasks set state = 1', 'attach database x as y']) {
    assert.ok(!planQuery([q]).ok, q);
  }
  assert.ok(!planQuery(['select 1', 'select 2']).ok);
  assert.ok(!planQuery(['']).ok);
});

test('parseCatalog keeps whole entries only; planAccess dispatches by type', () => {
  const { catalog, problems } = parseCatalog({ resources: {
    'kube:lumo-dev': { type: 'kube', namespace: 'lumo-dev', env: 'dev', projects: ['lumo'] },
    'kube:bad': { type: 'kube' },
    'ssh:ci-host': { type: 'ssh', host: 'h', allow: [{ argv: ['docker', 'images'] }, { argv: ['rm', '$x'] }] },
    'hq:query': { type: 'hq-query', env: 'internal' },
    'env:x': { type: 'env' },
  } });
  assert.deepEqual(Object.keys(catalog).sort(), ['hq:query', 'kube:lumo-dev', 'ssh:ci-host']);
  assert.equal(problems.length, 2);
  assert.equal((catalog['ssh:ci-host'] as SshResource).allow.length, 1, 'an entry with a word outside the charset is dropped');
  assert.ok(planAccess('kube:lumo-dev', catalog['kube:lumo-dev']!, ['get', 'pods']).ok);
});

test('redact replaces a line that looks like a secret and leaves the rest', () => {
  const out = redact('ok line\nGITHUB_TOKEN=ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB\nlast');
  assert.match(out, /^ok line\n\[שורה הוסתרה/);
  assert.match(out, /\nlast$/);
  assert.ok(!out.includes('ghp_'));
});

test('describeResource: an ssh allowlist reads as groups, and a change in prod is marked GO', () => {
  const k3s: SshResource = { type: 'ssh', host: 'h', env: 'prod', allow: [
    ...['pods', 'deploy', 'svc'].map((t) => ({ argv: ['kubectl', '-n', 'p', 'get', t], class: 'read' as const })),
    { argv: ['kubectl', '-n', 'p', 'get', 'pods', '-o', 'wide'], class: 'read' },
    { argv: ['kubectl', '-n', 'p', 'rollout', 'restart', 'deploy/*'], class: 'write' },
    { argv: ['kubectl', 'top', 'nodes'], class: 'read' },
  ] };
  const d = describeResource('ssh:k3s-prod', k3s);
  assert.match(d, /^`ssh:k3s-prod` \(פרודקשן/);
  assert.match(d, /kubectl -n p get \{pods\|deploy\|svc\|pods -o wide\}/);
  assert.match(d, /kubectl -n p rollout \{restart deploy\/\*\} \(GO\)/);
  assert.match(d, /למשל `kubectl -n p get pods`/, 'the example is a command that runs as is');
  const ci: SshResource = { type: 'ssh', host: 'h', env: 'ci', allow: [{ argv: ['df'] }, { argv: ['df', '-h'] }] };
  assert.match(describeResource('ssh:ci', ci), /מותר: df · df \{-h\}$/);
  assert.match(describeResource('ssh:none', { type: 'ssh', host: 'h', env: 'ci', allow: [] }), /אין עדיין פקודות/);
  assert.match(d, /kubectl top \{nodes\}/);
});

test('ssh:ci-host catalog: cgroup files of a slice and docker system df fit; other files and a way up do not', () => {
  const allow = [['docker', 'system', 'df'], ['cat', '/sys/fs/cgroup/*/memory.current'], ['cat', '/sys/fs/cgroup/*/cpu.stat']];
  const ok = (argv: string[]) => allow.some((p) => matchPattern(p, argv));
  assert.ok(ok(['docker', 'system', 'df']));
  assert.ok(ok(['cat', '/sys/fs/cgroup/ci.slice/memory.current']));
  assert.ok(ok(['cat', '/sys/fs/cgroup/system.slice/actions-runner.service/cpu.stat']));
  assert.ok(!ok(['cat', '/etc/shadow']));
  assert.ok(!ok(['cat', '/sys/fs/cgroup/../../etc/shadow']));
  assert.ok(!ok(['docker', 'system', 'prune']));
});
