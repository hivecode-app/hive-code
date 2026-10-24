// request_access, the closed lists: what a worker on the second server may ask hq to run in its name (two-servers-access-design.md).
// Pure: it reads a resource from the catalog and an argv, and says what hq would run (a plan), or why not. The rule is an
// allowlist. Whatever is not named here is `unfit` (counted, with a hint), never run; a few flags are `deny` for good.

/** read = looks only; write = changes something; exec = runs code inside the target. Anything but read in prod always goes to him. */
export type AccessClass = 'read' | 'write' | 'exec';

export interface KubeResource { type: 'kube'; namespace: string; kubeconfig?: string; context?: string; env?: string; projects?: string[] }
export interface SshAllow { argv: string[]; class?: AccessClass }
export interface SshResource { type: 'ssh'; host: string; user?: string; port?: number; key?: string; allow: SshAllow[]; env?: string; projects?: string[] }
export interface HqQueryResource { type: 'hq-query'; env?: string; projects?: string[] }
/** `build:<name>`: docker build and push of a repo's sha, on this machine, in a temp clone (access-build.sh). Pushes only under `registry`. */
export interface BuildResource { type: 'build'; registry: string; owners?: string[]; script?: string; env?: string; projects?: string[] }
export type Resource = KubeResource | SshResource | HqQueryResource | BuildResource;

/** The catalog file's resource names: `kube:<name>`, `ssh:<name>`, `build:<name>`, `hq:query`. */
export type Catalog = Record<string, Resource>;

/** What hq runs: a process (never through a shell of ours), or a read-only query on its own database. */
export type Plan =
  | { kind: 'process'; cmd: string; args: string[]; class: AccessClass; shown: string; lease?: { class: string; note: string } }
  | { kind: 'query'; sql: string; class: 'read'; shown: string };

export type Verdict = { ok: true; plan: Plan } | { ok: false; kind: 'deny' | 'unfit'; why: string; hint?: string };

/** A command as the card shows it: a word that would read as several (a space, a quote) is quoted, so what he approves is what runs. */
export const show = (words: string[]) => words.map((w) => (/^[A-Za-z0-9._:/=@,+%*{}\[\]<>-]+$/.test(w) ? w : JSON.stringify(w))).join(' ');

const unfit = (why: string, hint?: string): Verdict => ({ ok: false, kind: 'unfit', why, ...(hint ? { hint } : {}) });
const deny = (why: string): Verdict => ({ ok: false, kind: 'deny', why });

export const SAFE_ARG = /^[A-Za-z0-9._:/=@,+%-]+$/;
const SAFE_VALUE = /^[A-Za-z0-9._:/=@,+%*-]+$/;

// ── kubectl ────────────────────────────────────────────────────────────────

/** Flags that give a worker another cluster, another identity or a way around the namespace: refused whatever the verb. */
const KUBE_DENIED = new Set([
  'kubeconfig', 'token', 'as', 'as-group', 'as-uid', 'server', 's', 'context', 'cluster', 'user', 'certificate-authority',
  'client-certificate', 'client-key', 'insecure-skip-tls-verify', 'username', 'password', 'raw', 'all-namespaces', 'A', 'tls-server-name',
]);

const KUBE_TYPES = new Set(['pod', 'pods', 'po', 'deployment', 'deployments', 'deploy', 'replicaset', 'replicasets', 'rs', 'service', 'services', 'svc',
  'ingress', 'ingresses', 'ing', 'event', 'events', 'ev', 'job', 'jobs', 'cronjob', 'cronjobs', 'hpa', 'horizontalpodautoscaler', 'horizontalpodautoscalers',
  'statefulset', 'statefulsets', 'sts', 'daemonset', 'daemonsets', 'ds', 'endpoints', 'ep', 'persistentvolumeclaim', 'persistentvolumeclaims', 'pvc',
  'secret', 'secrets', 'configmap', 'configmaps', 'cm']);

type FlagKind = 'bool' | 'value';
interface Flag { name: string; short?: string; kind: FlagKind; check?: (v: string) => boolean }

const outputOk = (v: string) => /^(json|yaml|wide|name)$/.test(v) || /^(jsonpath|custom-columns)=\S+$/.test(v);
const durationOk = (v: string) => /^\d+(s|m|h)?$/.test(v);
const intOk = (v: string) => /^\d{1,6}$/.test(v);
const safeOk = (v: string) => SAFE_VALUE.test(v);
const selectorOk = (v: string) => /^[A-Za-z0-9._/=!,()\- ]+$/.test(v);

const F = {
  output: { name: 'output', short: 'o', kind: 'value', check: outputOk } as Flag,
  selector: { name: 'selector', short: 'l', kind: 'value', check: selectorOk } as Flag,
  container: { name: 'container', short: 'c', kind: 'value', check: safeOk } as Flag,
};

interface VerbSpec { cls: AccessClass; flags: Flag[]; min: number; max: number }

const KUBE_VERBS: Record<string, VerbSpec> = {
  get: { cls: 'read', min: 1, max: 2,
    flags: [F.output, F.selector, { name: 'show-labels', kind: 'bool' }, { name: 'no-headers', kind: 'bool' }, { name: 'sort-by', kind: 'value', check: safeOk },
      { name: 'field-selector', kind: 'value', check: selectorOk }] },
  describe: { cls: 'read', min: 1, max: 2, flags: [F.selector] },
  logs: { cls: 'read', min: 1, max: 1,
    flags: [{ name: 'tail', kind: 'value', check: intOk }, { name: 'since', kind: 'value', check: durationOk }, F.container, { name: 'previous', short: 'p', kind: 'bool' },
      { name: 'timestamps', kind: 'bool' }, { name: 'limit-bytes', kind: 'value', check: intOk }, F.selector, { name: 'all-containers', kind: 'bool' }, { name: 'prefix', kind: 'bool' }] },
  top: { cls: 'read', min: 1, max: 1, flags: [F.selector, { name: 'containers', kind: 'bool' }] },
  scale: { cls: 'write', min: 1, max: 1, flags: [{ name: 'replicas', kind: 'value', check: intOk }] },
  delete: { cls: 'write', min: 1, max: 1, flags: [] },
};

const NO_FOLLOW = 'יש `logs --tail=N --since=10m`; מעקב חי (`-f`) לא נתמך';

/** The words after `--`: a command inside a pod. The owner reads it as it is. */
function execTail(argv: string[]): { head: string[]; tail: string[] } | null {
  const i = argv.indexOf('--');
  if (i < 0) return null;
  return { head: argv.slice(0, i), tail: argv.slice(i + 1) };
}

interface Parsed { positional: string[]; flags: Map<string, string | true> }

/** Flags by spec only. A flag in KUBE_DENIED is refused for good; one that is not in the spec is `unfit`. */
function parseFlags(args: string[], spec: Flag[], namespace: string): Parsed | Verdict {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') || a === '-') { positional.push(a); continue; }
    const long = a.startsWith('--');
    const body = a.slice(long ? 2 : 1);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    let value: string | undefined = eq >= 0 ? body.slice(eq + 1) : undefined;
    if (name === 'namespace' || name === 'n') {
      value ??= args[++i];
      if (value !== namespace) return deny(`הדגל \`${name}\` נדחה: ה-namespace של המשאב הוא \`${namespace}\` ולא משתנה`);
      continue;
    }
    if (KUBE_DENIED.has(name)) return deny(`הדגל \`${name}\` אסור תמיד`);
    if (name === 'follow' || name === 'f') return unfit('מעקב חי (`-f`) לא נתמך', NO_FOLLOW);
    if (name === 'watch' || name === 'w') return unfit('`--watch` לא נתמך', 'אפשר `rollout status --timeout=5m` או `get` חוזר');
    const f = spec.find((x) => (long ? x.name === name : x.short === name));
    if (!f) return unfit(`הדגל \`${a.split('=')[0]}\` לא ברשימה המותרת לפקודה הזו`);
    if (f.kind === 'bool') {
      if (value !== undefined && value !== 'true') return unfit(`הדגל \`${name}\` בוליאני`);
      flags.set(f.name, true);
      continue;
    }
    value ??= args[++i];
    if (value === undefined || value.startsWith('-')) return unfit(`לדגל \`${name}\` חסר ערך`);
    if (f.check && !f.check(value)) return unfit(`הערך של \`${name}\` לא מותר: \`${value}\``);
    flags.set(f.name, value);
  }
  return { positional, flags };
}

const isVerdict = (p: Parsed | Verdict): p is Verdict => 'ok' in p;

/** get/describe: `type`, `type/name` or `type name`. The types are a list (secrets and configmaps too, no all); names are in the safe charset. */
function checkTyped(words: string[]): Verdict | null {
  const [first, second] = words;
  const parts = first!.split('/');
  if (parts.length > 2 || (parts.length === 2 && second !== undefined)) return unfit(`\`${words.join(' ')}\` לא מבנה מותר: סוג ושם אחד`);
  for (const k of parts[0]!.split(',')) if (!KUBE_TYPES.has(k.toLowerCase())) return unfit(`סוג המשאב \`${k}\` לא ברשימה המותרת (אין all)`);
  const name = parts[1] ?? second;
  if (name !== undefined && !SAFE_ARG.test(name)) return unfit(`השם \`${name}\` לא מותר`);
  return null;
}

/** exec/rollout: `name` or `type/name`, every part in the safe charset. */
function checkNamed(words: string[]): Verdict | null {
  for (const w of words) if (!w.split('/').every((x) => SAFE_ARG.test(x)) || w.split('/').length > 2) return unfit(`\`${w}\` לא מבנה מותר`);
  return null;
}

/** Builds `kubectl` for a resource and the words a worker gave. The namespace and the kubeconfig are the catalog's, not the worker's. */
export function planKube(res: KubeResource, argv: string[]): Verdict {
  const verb = argv[0];
  if (!verb) return unfit('חסרה פקודה');
  // The fences hold wherever the flag stands, also before the verb: it is read before anything else (and not past `--`, the pod's own words).
  const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  for (let i = 0; i < own.length; i++) {
    const m = /^--?([A-Za-z][A-Za-z-]*)(?:=(.*))?$/.exec(own[i]!);
    if (!m) continue;
    if (KUBE_DENIED.has(m[1]!)) return deny(`הדגל \`${m[1]}\` אסור תמיד`);
    if (m[1] === 'namespace' || m[1] === 'n') {
      const v = m[2] ?? own[i + 1];
      if (v !== res.namespace) return deny(`הדגל \`${m[1]}\` נדחה: ה-namespace של המשאב הוא \`${res.namespace}\` ולא משתנה`);
    }
  }
  if (verb.startsWith('-')) return unfit('הפקודה מתחילה בפועל (`get`, `logs`, …), לא בדגל');
  const base = ['kubectl', ...(res.kubeconfig ? ['--kubeconfig', res.kubeconfig] : []), ...(res.context ? ['--context', res.context] : []), '-n', res.namespace];
  const shown = `kubectl -n ${res.namespace} ${show(argv)}`;
  const done = (cls: AccessClass, args: string[]): Verdict => ({ ok: true, plan: { kind: 'process', cmd: base[0]!, args: [...base.slice(1), ...args], class: cls, shown } });

  if (verb === 'rollout') {
    const sub = argv[1];
    if (sub === 'status' || sub === 'history') {
      const p = parseFlags(argv.slice(2), sub === 'status' ? [{ name: 'timeout', kind: 'value', check: durationOk }] : [], res.namespace);
      if (isVerdict(p)) return p;
      if (p.positional.length !== 1) return unfit('`rollout` מקבל משאב אחד, למשל `deploy/api`');
      const bad = checkNamed(p.positional);
      if (bad) return bad;
      return done('read', ['rollout', sub, p.positional[0]!, ...(p.flags.has('timeout') ? [`--timeout=${String(p.flags.get('timeout'))}`] : [])]);
    }
    if (sub === 'restart' || sub === 'undo') {
      const p = parseFlags(argv.slice(2), sub === 'undo' ? [{ name: 'to-revision', kind: 'value', check: intOk }] : [], res.namespace);
      if (isVerdict(p)) return p;
      if (p.positional.length !== 1 || !/^(deploy|deployment|sts|statefulset|ds|daemonset)\/[A-Za-z0-9._-]+$/.test(p.positional[0]!)) return unfit('`rollout` על `deploy/<name>` אחד');
      return done('write', ['rollout', sub, p.positional[0]!, ...(p.flags.has('to-revision') ? [`--to-revision=${String(p.flags.get('to-revision'))}`] : [])]);
    }
    return unfit(`\`rollout ${sub ?? ''}\` לא ברשימה המותרת`, 'מותר: status, history, restart, undo');
  }

  if (verb === 'set') {
    if (argv[1] !== 'image') return unfit('מ-`set` מותר רק `set image`');
    const p = parseFlags(argv.slice(2), [], res.namespace);
    if (isVerdict(p)) return p;
    const [target, ...pairs] = p.positional;
    if (!target || !/^(deploy|deployment|sts|statefulset|ds|daemonset)\/[A-Za-z0-9._-]+$/.test(target) || !pairs.length || pairs.length > 4
      || pairs.some((x) => !/^[A-Za-z0-9._-]+=[A-Za-z0-9._:/@-]+$/.test(x))) return unfit('`set image deploy/<name> <container>=<image>`');
    return done('write', ['set', 'image', target, ...pairs]);
  }

  if (verb === 'exec') {
    const t = execTail(argv);
    if (!t || !t.tail.length) return unfit('`exec` רק עם `--` ופקודה אחת, בלי מעטפת אינטראקטיבית', 'למשל `exec deploy/api -- ls /app`; `-it` ו-`port-forward` לא נתמכים');
    if (t.head.some((x) => /^-[a-z]*[ti][a-z]*$/.test(x) && !x.startsWith('--') && x !== '-c')) return unfit('`exec` אינטראקטיבי (`-i`, `-t`) לא נתמך');
    const p = parseFlags(t.head.slice(1), [F.container], res.namespace);
    if (isVerdict(p)) return p;
    if (p.positional.length !== 1) return unfit('`exec <pod|deploy/name> -- <פקודה>`');
    const bad = checkNamed(p.positional);
    if (bad) return bad;
    if (t.tail.some((x) => x === '' || /[\u0000-\u001f]/.test(x))) return unfit('הפקודה בתוך ה-pod מכילה תו לא מותר');
    return done('exec', ['exec', p.positional[0]!, ...(p.flags.has('container') ? ['-c', String(p.flags.get('container'))] : []), '--', ...t.tail]);
  }

  if (verb === 'port-forward' || verb === 'proxy' || verb === 'cp' || verb === 'attach' || verb === 'edit' || verb === 'patch' || verb === 'apply' || verb === 'replace' || verb === 'create' || verb === 'run') {
    return unfit(`\`${verb}\` לא נתמך`, verb === 'apply' || verb === 'patch' ? 'פריסה: `set image deploy/<name> <container>=<image>` ואז `rollout status`' : verb === 'port-forward' ? 'חלופה: `exec <pod> -- curl localhost:PORT/…`' : undefined);
  }

  const spec = KUBE_VERBS[verb];
  if (!spec) return unfit(`\`${verb}\` לא ברשימה המותרת`, 'מותר: get, describe, logs, top, rollout status|history|restart|undo, set image, scale, delete (pod אחד), exec');
  const p = parseFlags(argv.slice(1), spec.flags, res.namespace);
  if (isVerdict(p)) return p;
  if (p.positional.length < spec.min || p.positional.length > spec.max) return unfit(`מספר הארגומנטים ל-\`${verb}\` לא מתאים`);
  if (verb === 'top') {
    if (!/^(pod|pods|po)$/.test(p.positional[0]!)) return unfit('`top` רק על pods');
  } else if (verb === 'scale') {
    if (!/^(deploy|deployment|sts|statefulset)\/[A-Za-z0-9._-]+$/.test(p.positional[0]!) || !p.flags.has('replicas')) return unfit('`scale deploy/<name> --replicas=N`');
  } else if (verb === 'delete') {
    if (!/^(pod|po)\/[A-Za-z0-9._-]+$/.test(p.positional[0]!)) return unfit('`delete` רק על `pod/<name>` אחד');
  } else if (verb === 'logs') {
    if (!/^((pod|po|deploy|deployment|job|sts|statefulset|ds|daemonset)\/)?[A-Za-z0-9._-]+$/.test(p.positional[0]!)) return unfit('`logs <pod|deploy/name>`');
    if (!p.flags.has('tail') && !p.flags.has('since') && !p.flags.has('limit-bytes')) return unfit('`logs` בלי `--tail` או `--since` יכול להחזיר הכול', NO_FOLLOW);
  } else {
    const bad = checkTyped(p.positional);
    if (bad) return bad;
  }
  const out: string[] = [verb];
  if (verb === 'scale') out.push(p.positional[0]!, `--replicas=${String(p.flags.get('replicas'))}`);
  else {
    out.push(...p.positional);
    for (const [k, v] of p.flags) out.push(v === true ? `--${k}` : `--${k}=${v}`);
  }
  return done(spec.cls, out);
}

// ── ssh ────────────────────────────────────────────────────────────────────

/** An allowlist pattern: a word is itself (a `*` inside it stands for safe text), `*` alone is one safe word, `**` at the end is any number of them. */
export function matchPattern(pattern: string[], argv: string[]): boolean {
  // A star never stands for a flag or a way up the tree: those must be named in the pattern to be allowed.
  // `..` counts as a step up after `=`, `:`, `,` or `@` too ("if=../etc"), not only between slashes.
  const noUp = (a: string) => !a.split(/[/=:,@]/).includes('..');
  const wild = (a: string) => !a.startsWith('-') && noUp(a);
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p === '**') return i === pattern.length - 1 && argv.slice(i).every(wild);
    const a = argv[i];
    if (a === undefined) return false;
    if (p === '*') { if (!wild(a)) return false; continue; }
    // A word with a star in it ("ghcr.io/hive-owner/*") matches any safe text in the star's place. A pattern that names
    // its flag up to the `=` ("--tail=*") lets the word be that flag; "-n*" would let "-nf" in, so it does not.
    if (p.includes('*')) {
      const re = new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[A-Za-z0-9._:/=@,+%-]*')}$`);
      const flag = p.startsWith('-') && p.slice(0, p.indexOf('*')).endsWith('=');
      if (!re.test(a) || !(flag ? noUp(a) : wild(a))) return false;
    } else if (p !== a) return false;
  }
  return argv.length === pattern.length;
}

/** `ssh` for the resource, running only what the catalog lists. Every word is in the safe charset, so the remote shell has nothing to interpret. */
export function planSsh(res: SshResource, argv: string[]): Verdict {
  if (!argv.length) return unfit('חסרה פקודה');
  const bad = argv.find((a) => !SAFE_ARG.test(a));
  if (bad !== undefined) return unfit(`המילה \`${bad}\` מכילה תו שלא מותר (אותיות, ספרות ו-\`._:/=@,+%-\` בלבד)`, 'פקודה עם צינור, מרכאות או משתנה לא מוגשת. אפשר סקריפט שכבר נמצא בשרת');
  const hit = res.allow.find((r) => matchPattern(r.argv, argv));
  if (!hit) return unfit(`הפקודה \`${argv.join(' ')}\` לא ברשימה המותרת של המשאב`, res.allow.length ? `מותר: ${sshAllowed(res)}` : 'לרשימה של המשאב אין עדיין פקודות');
  const target = `${res.user ? `${res.user}@` : ''}${res.host}`;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(res.key ? ['-i', res.key, '-o', 'IdentitiesOnly=yes'] : []), ...(res.port ? ['-p', String(res.port)] : []), target, '--', ...argv];
  return { ok: true, plan: { kind: 'process', cmd: 'ssh', args, class: hit.class ?? 'read', shown: `ssh ${target} ${show(argv)}` } };
}

/** The allowlist in a few lines, so a worker reads what fits instead of guessing: one group per command head, its tails in braces. */
function sshAllowed(res: SshResource): string {
  const prod = res.env === undefined || res.env === 'prod';
  const groups = new Map<string, string[]>();
  for (const r of res.allow) {
    const cut = Math.max(1, Math.min(4, r.argv.length - 1));
    const key = r.argv.slice(0, cut).join(' ') + (prod && r.class !== 'read' && r.class !== undefined ? '\u0000GO' : '');
    const tail = r.argv.slice(cut).join(' ');
    const g = groups.get(key) ?? [];
    if (!g.includes(tail)) g.push(tail);
    groups.set(key, g);
  }
  return [...groups].map(([key, tails]) => {
    // Too many tails to read: numbers become N ("--tail=N"), and if that is still too many, their first words only ("get {pods|deploy|…}").
    const numbered = tails.length > 10 ? [...new Set(tails.map((t) => t.replace(/\d+/g, 'N')))] : tails;
    const shown = numbered.length > 10 ? [...new Set(tails.map((t) => t.split(' ')[0]!))] : numbered;
    const words = shown.length > 16 ? [...shown.slice(0, 16), '…'] : shown;
    const [head, go] = key.split('\u0000');
    const rest = words.filter((w) => w !== '');
    // A bare command next to its longer forms reads "df · df {-h}", not "df {|-h}".
    const out = [...(words.includes('') ? [head] : []), ...(rest.length ? [`${head} {${rest.join('|')}}`] : [])].join(' · ');
    return go ? `${out} (GO)` : out;
  }).join(' · ');
}

/** What a resource offers, in one line: shown when a worker asks for a name that is not there, so the next call fits. */
export function describeResource(name: string, res: Resource): string {
  const env = res.env === undefined || res.env === 'prod' ? 'פרודקשן: קריאה רצה מיד, שינוי בכרטיס GO' : `${res.env}: רץ מיד`;
  switch (res.type) {
    case 'kube': return `\`${name}\` (${env}): kubectl ב-namespace \`${res.namespace}\`, בלי \`kubectl\` ובלי \`-n\` ב-argv: get, describe, logs --tail, top pods, rollout status|history|restart|undo, set image, scale, delete pod/<name>, exec <pod> -- <פקודה>`;
    case 'ssh': {
      if (!res.allow.length) return `\`${name}\` (${env}): לרשימה של המשאב אין עדיין פקודות`;
      const example = res.allow.find((r) => !r.argv.some((w) => w.includes('*')));
      return `\`${name}\` (${env}): argv מלא${example ? `, למשל \`${example.argv.join(' ')}\`` : ''}. מותר: ${sshAllowed(res)}`;
    }
    case 'build': return `\`${name}\` (${env}): docker build ושליחה ל-\`${res.registry}\`. argv: [repo, sha מלא, נתיב Dockerfile, תג מלא, context אופציונלי]`;
    case 'hq-query': return `\`${name}\` (${env}): SELECT אחד על hq.db, ב-argv מחרוזת אחת`;
  }
}

// ── build and push ─────────────────────────────────────────────────────────

export const DEFAULT_REGISTRY = 'ghcr.io/hive-owner/';
const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const SHA = /^[0-9a-f]{40}$/;
const REL_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** A relative path inside the clone: no way up, no flag, no absolute path. */
const relPathOk = (p: string) => REL_PATH.test(p) && !p.split('/').includes('..') && !p.startsWith('-');

/** `[repo, sha, dockerfile, tag, context?]` → the build script under a `docker` lease. The repo is ours, the sha is whole, the tag is under the registry. */
export function planBuild(res: BuildResource, argv: string[]): Verdict {
  const usage = '`["hive-owner/<repo>", "<sha של 40 תווים>", "<נתיב Dockerfile>", "ghcr.io/hive-owner/<שם>:<תג>", "<context, ברירת מחדל .>"]`';
  if (argv.length < 4 || argv.length > 5) return unfit('build מקבל repo, sha, נתיב ל-Dockerfile ותג (ואופציונלית context)', usage);
  const [repo, sha, dockerfile, tag, context = '.'] = argv as [string, string, string, string, string?];
  const m = REPO.exec(repo);
  if (!m) return unfit(`\`${repo}\` לא בצורה owner/name`, usage);
  const owners = res.owners ?? ['hive-owner'];
  // A repo of another owner is allowed in the catalog by name, once we have WRITE on it (access-build.sh checks that too).
  if (!owners.includes(m[1]!) && !owners.includes(repo)) return deny(`ה-repo \`${repo}\` לא שלנו: מותר רק של ${owners.join(', ')}`);
  if (!SHA.test(sha)) return unfit('ה-sha חייב להיות מלא (40 תווים, אותיות קטנות): ענף או תג לא מספיקים, כי הבנייה חייבת להיות קומיט אחד', usage);
  if (!relPathOk(dockerfile)) return unfit(`נתיב ה-Dockerfile \`${dockerfile}\` לא מותר: יחסי ל-repo, בלי \`..\``);
  if (context !== '.' && !relPathOk(context)) return unfit(`ה-context \`${context}\` לא מותר: תיקייה יחסית ל-repo, בלי \`..\``);
  const registry = res.registry.endsWith('/') ? res.registry : `${res.registry}/`;
  const t = /^([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/.exec(tag);
  if (!t || !tag.startsWith(registry) || tag.length === registry.length || t[1]!.split('/').includes('..')) {
    return deny(`התג חייב להיות תחת \`${registry}\` ובצורה \`${registry}<שם>:<תג>\``);
  }
  const script = res.script ?? 'access-build.sh';
  return { ok: true, plan: { kind: 'process', cmd: script, args: [repo, sha, dockerfile, tag, context], class: 'write',
    shown: `build ${repo}@${sha.slice(0, 12)} ${dockerfile} → ${tag}`, lease: { class: 'docker', note: `docker build ושליחה של ${repo} ל-${tag}` } } };
}

// ── hq.db, read only ───────────────────────────────────────────────────────

const SENSITIVE_TABLES = /\b(devices|passkeys|pair_codes|push_subscriptions|accounts|tab_handoffs)\b/i;
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|load_extension|savepoint|begin|commit|rollback)\b/i;

/** One SELECT (or WITH … SELECT) on hq.db. The connection is read-only as well; this keeps the card honest and the tokens out. */
export function planQuery(argv: string[]): Verdict {
  if (argv.length !== 1) return unfit('`hq:query` מקבל מחרוזת SQL אחת ב-`argv`');
  const sql = argv[0]!.trim().replace(/;\s*$/, '');
  if (!sql) return unfit('השאילתה ריקה');
  if (sql.includes(';')) return unfit('שאילתה אחת בלבד');
  if (!/^(select|with)\b/i.test(sql)) return unfit('רק SELECT (או WITH … SELECT)');
  if (WRITE_WORDS.test(sql)) return deny('השאילתה מכילה מילה של כתיבה או pragma');
  if (SENSITIVE_TABLES.test(sql)) return deny('הטבלאות של התקנים, passkeys, חשבונות ו-handoffs של הדפדפן סגורות');
  return { ok: true, plan: { kind: 'query', sql, class: 'read', shown: `hq.db: ${sql.length > 200 ? `${sql.slice(0, 199)}…` : sql}` } };
}

// ── one entry point ────────────────────────────────────────────────────────

export function planAccess(name: string, res: Resource, argv: string[]): Verdict {
  switch (res.type) {
    case 'kube': return planKube(res, argv);
    case 'ssh': return planSsh(res, argv);
    case 'build': return planBuild(res, argv);
    case 'hq-query': return planQuery(argv);
    default: return unfit(`סוג משאב לא מוכר ב-${name}`);
  }
}

/** The catalog's file is data a person edited: only entries that are whole make it in. */
export function parseCatalog(raw: unknown): { catalog: Catalog; problems: string[] } {
  const catalog: Catalog = {};
  const problems: string[] = [];
  const src = (raw && typeof raw === 'object' ? (raw as { resources?: unknown }).resources : null) as Record<string, unknown> | null;
  if (!src || typeof src !== 'object') return { catalog, problems: ['catalog.json: חסר `resources`'] };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  for (const [name, v] of Object.entries(src)) {
    const o = (v ?? {}) as Record<string, unknown>;
    const projects = Array.isArray(o.projects) ? o.projects.filter((x): x is string => typeof x === 'string') : undefined;
    const common = { ...(str(o.env) ? { env: str(o.env)! } : {}), ...(projects ? { projects } : {}) };
    if (/^kube:[a-z0-9-]+$/.test(name) && o.type === 'kube' && str(o.namespace)) {
      catalog[name] = { type: 'kube', namespace: str(o.namespace)!, ...(str(o.kubeconfig) ? { kubeconfig: str(o.kubeconfig)! } : {}),
        ...(str(o.context) ? { context: str(o.context)! } : {}), ...common };
    } else if (/^ssh:[a-z0-9-]+$/.test(name) && o.type === 'ssh' && str(o.host)) {
      const allow = (Array.isArray(o.allow) ? o.allow : []).flatMap((x): SshAllow[] => {
        const e = (x ?? {}) as Record<string, unknown>;
        const a = Array.isArray(e.argv) ? e.argv.filter((w): w is string => typeof w === 'string' && (/^[A-Za-z0-9._:/=@,+%*-]+$/.test(w))) : [];
        const cls = e.class === 'write' || e.class === 'exec' || e.class === 'read' ? e.class : 'read';
        return a.length && a.length === (e.argv as unknown[]).length ? [{ argv: a, class: cls }] : [];
      });
      catalog[name] = { type: 'ssh', host: str(o.host)!, ...(str(o.user) ? { user: str(o.user)! } : {}), ...(typeof o.port === 'number' ? { port: o.port } : {}),
        ...(str(o.key) ? { key: str(o.key)! } : {}), allow, ...common };
    } else if (/^build:[a-z0-9-]+$/.test(name) && o.type === 'build') {
      const owners = Array.isArray(o.owners) ? o.owners.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9._/-]+$/.test(x)) : undefined;
      catalog[name] = { type: 'build', registry: str(o.registry) && /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*\/?$/.test(str(o.registry)!) ? str(o.registry)! : DEFAULT_REGISTRY,
        ...(owners?.length ? { owners } : {}), ...(str(o.script) ? { script: str(o.script)! } : {}), ...common };
    } else if (name === 'hq:query' && o.type === 'hq-query') {
      catalog[name] = { type: 'hq-query', ...common };
    } else problems.push(`${name}: רשומה לא תקינה`);
  }
  return { catalog, problems };
}
