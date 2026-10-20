// org.yaml format versions (docs/generic/PLAN.md §5). org.yaml carries `version`; ORG_VERSION is the one this engine
// reads. A format change bumps ORG_VERSION and appends one migration here: `company update` never rewrites a company's
// org.yaml by itself, it opens the migration as a PR in the company's repo and waits for it to be merged.
// A migration works on the text, so comments and order survive: org.yaml is written and read by people.

/** The org.yaml format this engine reads. */
export const ORG_VERSION = 1;

/**
 * One per format change, in order: { to, title, apply(text) => text }. `to` is the version it produces (from = to - 1).
 * `title` is a Hebrew line for the PR. apply() must not touch `version:`: migrateOrg sets it.
 * @type {{ to: number, title: string, apply: (text: string) => string }[]}
 */
export const ORG_MIGRATIONS = [];

const VERSION_LINE = /^version:[ \t]*(\S+?)[ \t]*(#.*)?$/m;

/** The `version` of an org.yaml text; a missing line is version 1 (every org.yaml before versions were checked). */
export function orgVersion(text) {
  const m = VERSION_LINE.exec(text);
  if (!m) return 1;
  const v = Number(m[1].replace(/^["']|["']$/g, ''));
  if (!Number.isInteger(v) || v < 1) throw new Error(`org.yaml: version לא תקין (${m[1]})`);
  return v;
}

/** What `company update` has to do about org.yaml before it switches to an engine that reads `engineVersion`. */
export function orgPlan(text, engineVersion = ORG_VERSION, migrations = ORG_MIGRATIONS) {
  const from = orgVersion(text);
  if (from === engineVersion) return { action: 'ok', from, to: from, steps: [] };
  if (from > engineVersion) return { action: 'newer', from, to: engineVersion, steps: [] };
  const steps = [];
  for (let v = from + 1; v <= engineVersion; v++) {
    const m = migrations.find((x) => x.to === v);
    if (!m) return { action: 'missing', from, to: engineVersion, missing: v, steps };
    steps.push(m);
  }
  return { action: 'migrate', from, to: engineVersion, steps };
}

/** Applies every step of the plan and sets `version:` to its target. */
export function migrateOrg(text, plan) {
  if (plan.action !== 'migrate') throw new Error(`אין מה להעביר (${plan.action})`);
  let out = text;
  for (const s of plan.steps) {
    out = s.apply(out);
    out = VERSION_LINE.test(out)
      ? out.replace(VERSION_LINE, (_l, _v, c) => `version: ${s.to}${c ? ` ${c}` : ''}`)
      : `version: ${s.to}\n${out}`;
  }
  return out;
}
