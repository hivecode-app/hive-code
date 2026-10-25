import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBuild, type BuildResource } from '../src/access-policy.ts';
import { describeResource, matchPattern, parseCatalog, planAccess, planKube, planQuery, planSsh, type KubeResource, type Plan, type SshResource } from '../src/access-policy.ts';

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

test('kube: in prod reads run in full, secrets, describe and yaml/json included', () => {
  const prod: KubeResource = { type: 'kube', namespace: 'lumo-prod', kubeconfig: '/k/prod.yaml', env: 'prod' };
  for (const r of [prod, { ...prod, env: undefined }]) {
    for (const a of [['get', 'deploy/api', '-o', 'yaml'], ['get', 'pods', '-o', 'json'], ['get', 'pods,svc', '-o', 'json'], ['get', 'deploy', 'api', '--output=jsonpath={.spec}'],
      ['get', 'job', '-o', 'custom-columns=E:.spec.template.spec.containers[*].env'], ['get', 'secret', 'db', '-o', 'yaml'], ['get', 'secrets', '-o', 'json'], ['get', 'secret/db'],
      ['get', 'configmaps'], ['get', 'cm/app', '-o', 'yaml'], ['describe', 'pod', 'api-7d9'], ['describe', 'deploy/api'], ['describe', 'secret', 'db']]) {
      const v = planKube(r, a);
      assert.ok(v.ok && v.plan.class === 'read', `${a.join(' ')} runs as a read in prod`);
    }
  }
});

test('kube: all, follow, port-forward, apply and interactive exec are unfit, with a way out', () => {
  bad(['get', 'all'], 'unfit');
  bad(['delete', 'secret/db'], 'unfit');
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

test('ssh:nws catalog: docker inspect of one or more containers is a read', () => {
  const res: SshResource = { type: 'ssh', host: '203.0.113.12', user: 'root', key: '/k/hakav', env: 'prod', allow: [{ argv: ['docker', 'inspect', '*', '**'], class: 'read' }] };
  for (const argv of [['docker', 'inspect', 'nws-app'], ['docker', 'inspect', 'nws-app', 'kafka-1']]) {
    const v = planSsh(res, argv);
    assert.ok(v.ok && v.plan.class === 'read', argv.join(' '));
  }
  for (const argv of [['docker', 'inspect'], ['docker', 'inspect', '--format', 'x'], ['docker', 'inspect', 'a', '-f']]) assert.ok(!planSsh(res, argv).ok, argv.join(' '));
});

const buildRes: BuildResource = { type: 'build', registry: 'ghcr.io/hive-owner/', env: 'registry', script: '/s/access-build.sh' };
const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const b = (...argv: string[]) => planBuild(buildRes, argv);

test('build: our repo, a whole sha and a tag under the registry become the build script, under a docker lease', () => {
  const v = b('hive-owner/lumo', SHA40, 'deploy/Dockerfile', 'ghcr.io/hive-owner/lumo-api:dev-0123456');
  assert.ok(v.ok);
  assert.deepEqual(v.plan, { kind: 'process', cmd: '/s/access-build.sh', args: ['hive-owner/lumo', SHA40, 'deploy/Dockerfile', 'ghcr.io/hive-owner/lumo-api:dev-0123456', '.'], class: 'write',
    shown: 'build hive-owner/lumo@0123456789ab deploy/Dockerfile → ghcr.io/hive-owner/lumo-api:dev-0123456', lease: { class: 'docker', note: 'docker build ושליחה של hive-owner/lumo ל-ghcr.io/hive-owner/lumo-api:dev-0123456' } });
  assert.ok(b('hive-owner/lumo', SHA40, 'Dockerfile', 'ghcr.io/hive-owner/a/b:1.2', 'services/api').ok);
});

test('build: another owner, a tag outside the registry, a short sha or a path up the tree are refused', () => {
  const t = 'ghcr.io/hive-owner/x:1';
  const refused = (v: ReturnType<typeof b>, kind: 'deny' | 'unfit') => { assert.ok(!v.ok); assert.equal(v.kind, kind, v.why); };
  refused(b('stranger/repo', SHA40, 'Dockerfile', t), 'deny');
  refused(b('hive-owner/lumo', SHA40, 'Dockerfile', 'ghcr.io/stranger/x:1'), 'deny');
  refused(b('hive-owner/lumo', SHA40, 'Dockerfile', 'docker.io/hive-owner/x:1'), 'deny');
  refused(b('hive-owner/lumo', SHA40, 'Dockerfile', 'ghcr.io/hive-owner/x'), 'deny');
  refused(b('hive-owner/lumo', SHA40, 'Dockerfile', 'ghcr.io/hive-owner/../stranger/x:1'), 'deny');
  refused(b('hive-owner/lumo', 'main', 'Dockerfile', t), 'unfit');
  refused(b('hive-owner/lumo', SHA40.slice(0, 12), 'Dockerfile', t), 'unfit');
  refused(b('hive-owner/lumo', SHA40, '../Dockerfile', t), 'unfit');
  refused(b('hive-owner/lumo', SHA40, '/etc/passwd', t), 'unfit');
  refused(b('hive-owner/lumo', SHA40, 'Dockerfile', t, '../..'), 'unfit');
  refused(b('hive-owner/lumo', SHA40, '--target=x', t), 'unfit');
  refused(b('hive-owner/lumo'), 'unfit');
  // another owner's repo only by name in the catalog, once we have WRITE on it
  assert.ok(planBuild({ ...buildRes, owners: ['hive-owner', 'partner/shared'] }, ['partner/shared', SHA40, 'Dockerfile', t]).ok);
  assert.ok(!planBuild({ ...buildRes, owners: ['hive-owner', 'partner/shared'] }, ['partner/other', SHA40, 'Dockerfile', t]).ok);
});

test('build: the catalog entry loads with the default registry, and a registry outside ghcr is dropped to it', () => {
  const { catalog } = parseCatalog({ resources: { 'build:hq-host': { type: 'build', env: 'registry' }, 'build:evil': { type: 'build', registry: 'evil.io/x/' } } });
  assert.equal((catalog['build:hq-host'] as BuildResource).registry, 'ghcr.io/hive-owner/');
  assert.equal((catalog['build:evil'] as BuildResource).registry, 'ghcr.io/hive-owner/');
});

// ── #302: words with spaces and quotes reach the far side as they were, and a read query in a pod is a read ──

import { execFileSync } from 'node:child_process';
import { isReadSql, readPsql, shQuote } from '../src/access-policy.ts';

const prod: SshResource = { type: 'ssh', host: '203.0.113.15', user: 'root', env: 'prod', allow: [
  { argv: ['kubectl', '-n', 'lumo-prod', 'get', 'pods'], class: 'read' },
  { argv: ['kubectl', '-n', 'lumo-prod', 'exec', '*', '--', '**'], class: 'exec' },
  { argv: ['kubectl', '-n', 'lumo-prod', 'exec', '*', '-c', '*', '--', '**'], class: 'exec' },
  { argv: ['docker', 'inspect', '*', '**'], class: 'read' }] };
const sshPlan = (argv: string[]) => {
  const v = planSsh(prod, argv);
  assert.ok(v.ok && v.plan.kind === 'process', `${argv.join(' ')} → ${v.ok ? '' : v.why}`);
  return v.plan as Extract<Plan, { kind: 'process' }>;
};
/** What the remote shell does with the words after `--`: ssh joins them with spaces, and sh parses them again. */
const farSide = (args: string[]) => {
  const remote = args.slice(args.indexOf('--') + 1).join(' ');
  return JSON.parse(execFileSync('/bin/sh', ['-c', `node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- ${remote}`], { encoding: 'utf8' })) as string[];
};

test('ssh: spaces, single and double quotes, `;`, `$` and backslashes arrive as the same words', () => {
  const tricky = [`a b`, `it's`, `say "hi"`, `x; rm -rf /tmp/never`, `$(id) \`id\` $HOME`, `back\\slash`, `'`, `"`, `''`, `a\nb`];
  for (const w of tricky) assert.deepEqual(farSide(['--', shQuote(w)]), [w], JSON.stringify(w));
  const argv = ['kubectl', '-n', 'lumo-prod', 'exec', 'db-1', '--', 'sh', '-c', `echo "it's"; echo 'a b'`];
  const p = sshPlan(argv);
  assert.equal(p.class, 'exec');
  assert.deepEqual(farSide(p.args), argv, 'nothing split, nothing run by the remote shell');
  assert.ok(p.shown.includes(JSON.stringify(`echo "it's"; echo 'a b'`)), 'the card shows the word as one word');
});

test('ssh: free text only where the pattern hands words to the command inside the pod', () => {
  for (const argv of [['kubectl', '-n', 'lumo-prod', 'get', 'pods;', 'id'], ['kubectl', '-n', 'lumo-prod', 'exec', 'db 1', '--', 'ls'],
    ['docker', 'inspect', 'api', 'a b'], ['docker', 'inspect', 'api', '--format', 'x'], ['kubectl', '-n', 'lumo-prod', 'exec', 'db-1', '--', 'ls\u0001']]) {
    const v = planSsh(prod, argv);
    assert.ok(!v.ok && v.kind === 'unfit', JSON.stringify(argv));
  }
  assert.ok(matchPattern(['exec', '*', '--', '**'], ['exec', 'p', '--', 'psql', '-c', 'select 1']));
  assert.ok(!matchPattern(['describe', '**'], ['describe', '--kubeconfig=/x']), 'before a `--` a flag stays out');
});

test('ssh: `psql -c` with a read query in a prod pod is a read, run in a read-only transaction', () => {
  const sql = `select id, name from users where email = 'a@b.co' and note <> 'it''s "x"; y' order by id limit 5;`;
  const argv = ['kubectl', '-n', 'lumo-prod', 'exec', 'lumo-db-1', '-c', 'postgres', '--', 'psql', '-U', 'postgres', '-d', 'lumo', '-A', '-c', sql];
  const p = sshPlan(argv);
  assert.equal(p.class, 'read', 'runs now, no GO');
  const far = farSide(p.args);
  assert.deepEqual(far.slice(0, 8), argv.slice(0, 8));
  assert.deepEqual(far.slice(8), ['env', 'PGOPTIONS=-c default_transaction_read_only=on -c standard_conforming_strings=on', 'psql', '-X', '-U', 'postgres', '-d', 'lumo', '-A', '-c', sql]);
  assert.ok(p.shown.includes('default_transaction_read_only=on'), 'the card shows the read-only guard');
  // The same words that write, or a psql that could, stay an exec: a GO card, not a refusal.
  for (const tail of [['-c', `delete from users where id = 1`], ['-c', `select 1; delete from users`], ['-c', `select 1;`, '-c', 'select 2'],
    ['options=-cdefault_transaction_read_only=off', '-c', 'select 1'], ['-d', 'dbname=x options=-cstandard_conforming_strings=off', '-c', 'select 1'],
    ['-d', 'options=-cstandard_conforming_strings=off', '-c', `select '\\'' ; delete from users; -- '`], ['-h', 'a=b', '-c', 'select 1'],
    ['-f', '/tmp/x.sql'], ['-o', '/tmp/out', '-c', 'select 1'], ['-v', 'x=1', '-c', 'select 1'], ['-c', `\\! id`], []]) {
    assert.equal(sshPlan([...argv.slice(0, 8), 'psql', ...tail]).class, 'exec', JSON.stringify(tail));
  }
  assert.equal(sshPlan(['kubectl', '-n', 'lumo-prod', 'exec', 'db-1', '--', 'sh', '-c', 'psql -c "select 1"']).class, 'exec');
});

test('isReadSql: one statement that only reads, judged outside strings and comments', () => {
  for (const s of [`select 1`, `SELECT * FROM t WHERE a = 'delete'`, `with x as (select 1) select * from x`, `show server_version`,
    `explain select 1`, `select count(*) from pg_stat_activity`, `select 'a;b'`, `select "update" from t`, `select $$ drop $$`,
    `select 1 -- ; drop table t\n`, `select /* insert */ 1;  `, `select case when a then 1 else 2 end from t`, `select E'it\\'s; drop'`]) {
    assert.ok(isReadSql(s), s);
  }
  for (const s of [`delete from t`, `select 1; select 2`, `select 1; drop table t`, `update t set a = 1`, `insert into t values (1)`,
    `with d as (delete from t returning *) select * from d`, `select * into t2 from t`, `explain analyze delete from t`,
    `select pg_terminate_backend(1)`, `select "pg_terminate_backend"(1)`, `select pg_catalog.set_config('x', 'y', false)`,
    `select nextval('s')`, `select pg_sleep_for('1 hour')`, `select pg_stat_reset()`, `select pg_stat_statements_reset()`, `select lo_import('/etc/passwd')`, `select pg_read_file('/etc/passwd')`, `select * from t for update`,
    `copy t to stdout`, `set role x`, `\\! id`, `select U&"pg\\005fsleep"(1)`, `select 'unclosed`, `select /* open`, `vacuum`, ``, `;`]) {
    assert.ok(!isReadSql(s), s);
  }
});

test('readPsql: only `kubectl … exec … -- psql` with known flags and one -c', () => {
  assert.equal(readPsql(['kubectl', 'exec', 'p', '--', 'psql', '-c', 'select 1'])?.at(-1), 'select 1');
  assert.equal(readPsql(['kubectl', 'exec', 'p', '--', 'psql', 'lumo', '-c', 'select 1'])?.includes('lumo'), true);
  assert.equal(readPsql(['kubectl', 'exec', 'p', '--', 'psql', 'a', 'b', '-c', 'select 1']), null, 'one database name');
  assert.equal(readPsql(['kubectl', 'exec', 'p', '--', 'psql', '-U', '-c', 'select 1']), null);
  assert.equal(readPsql(['docker', 'exec', 'p', '--', 'psql', '-c', 'select 1']), null);
  assert.equal(readPsql(['kubectl', 'exec', 'p', '--', 'env', 'psql', '-c', 'select 1']), null);
});
