#!/usr/bin/env node
// Schema check for the company contract (company/, memory/). Node 22; needs `npm ci` (for `yaml`).
// Usage: node scripts/check-contract.mjs [companyHome | --home [path]]
//   companyHome: a checkout with company/ and memory/ at its root (starter, fixtures/company-home, a worktree).
//   --home (and no argument at all): the company at COMPANY_HOME (env, else hq.config.json's companyHome); nothing to
//   do when none is set. The engine carries no company of its own.
//   --home <path>: that checkout (e.g. a worktree of a PR in the company's repo). `npm run check:contract -- --home <path>`
//   reaches here as `--home --home <path>`: the last argument that is not --home wins.
// Exit 0 = valid (warnings allowed), 1 = errors found.

import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { parse as yamlParse } from 'yaml';
import { resolveCompanyHome } from '../packages/shared/src/company-home.ts';
import { TONES } from '../packages/shared/src/index.ts';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const given = args.filter((a) => a !== '--home').at(-1);
const homeMode = args.includes('--home') || !given;
const root = given ? resolve(given) : resolveCompanyHome({ fallback: engineRoot });
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const rel = (p) => relative(root, p);

// ---------------------------------------------------------------------------
// Minimal YAML subset parser: block mappings, block sequences (of scalars or
// mappings), flow sequences of scalars ([a, b], []), empty flow map ({}),
// quoted and plain scalars, comments. Enough for org.yaml and frontmatter;
// anything outside the subset is a parse error, not a silent misread.
// ---------------------------------------------------------------------------
export function parseYaml(src, file = '<yaml>') {
  const lines = [];
  src.split(/\r?\n/).forEach((raw, n) => {
    if (/^\s*#/.test(raw) || raw.trim() === '') return;
    if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`${file}:${n + 1}: tab indentation`);
    lines.push({ indent: raw.match(/^ */)[0].length, text: stripComment(raw.trim()), n: n + 1 });
  });
  let i = 0;

  function stripComment(t) {
    let q = null;
    for (let k = 0; k < t.length; k++) {
      const c = t[k];
      if (q) { if (c === q && t[k - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'") { if (k === 0 || /[\s:\[,{-]/.test(t[k - 1])) q = c; continue; }
      if (c === '#' && k > 0 && /\s/.test(t[k - 1])) return t.slice(0, k).trimEnd();
    }
    return t;
  }

  function scalar(v, n) {
    if (v === '' || v === '~' || v === 'null') return null;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) throw new Error(`${file}:${n}: unterminated string`);
      return JSON.parse(v);
    }
    if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) throw new Error(`${file}:${n}: unterminated string`);
      return v.slice(1, -1).replace(/''/g, "'");
    }
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw new Error(`${file}:${n}: unterminated flow sequence`);
      const inner = v.slice(1, -1).trim();
      if (inner === '') return [];
      if (/[\[\]{}]/.test(inner)) throw new Error(`${file}:${n}: nested flow collections are outside the subset`);
      return inner.split(',').map((s) => scalar(s.trim(), n));
    }
    if (v === '{}') return {};
    if (v.startsWith('{')) throw new Error(`${file}:${n}: flow mappings are outside the subset; use block style`);
    return v;
  }

  const KEY = /^([A-Za-z0-9_\-]+):(?:\s+(.*))?$/;

  function parseBlock(indent) {
    const first = lines[i];
    if (!first || first.indent < indent) return null;
    return first.text === '-' || first.text.startsWith('- ') ? parseSeq(first.indent) : parseMap(first.indent);
  }

  function parseSeq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
      const line = lines[i];
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      if (rest === '') { i++; out.push(parseBlock(indent + 1)); continue; }
      if (KEY.test(rest)) {
        // "- key: value" starts a mapping whose keys sit at indent + 2.
        lines[i] = { indent: indent + 2, text: rest, n: line.n };
        out.push(parseMap(indent + 2));
      } else {
        i++;
        out.push(scalar(rest, line.n));
      }
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`${file}:${lines[i].n}: unexpected indentation`);
    return out;
  }

  function parseMap(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i];
      if (line.text.startsWith('- ')) break;
      const m = line.text.match(KEY);
      if (!m) throw new Error(`${file}:${line.n}: expected "key: value", got "${line.text}"`);
      const [, key, val = ''] = m;
      if (Object.hasOwn(out, key)) throw new Error(`${file}:${line.n}: duplicate key "${key}"`);
      i++;
      if (val.trim() !== '') { out[key] = scalar(val.trim(), line.n); continue; }
      const next = lines[i];
      if (next && next.indent > indent) out[key] = parseBlock(next.indent);
      else if (next && next.indent === indent && next.text.startsWith('- ')) out[key] = parseSeq(indent);
      else out[key] = null;
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`${file}:${lines[i].n}: unexpected indentation`);
    return out;
  }

  const doc = parseBlock(0);
  if (i < lines.length) throw new Error(`${file}:${lines[i].n}: could not parse "${lines[i].text}"`);
  return doc;
}

// hq reads org.yaml and charters with the `yaml` package, and marks a file it cannot
// parse invalid. Parse with it too, so the contract never passes what hq would reject.
// firstLine: the file line where src starts (2 for frontmatter, after the opening ---).
export function strictYaml(src, file, firstLine = 1) {
  try { yamlParse(src); } catch (e) {
    const line = e.linePos?.[0]?.line;
    const msg = String(e.message).split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new Error(`${file}:${line ? line + firstLine - 1 : '?'}: invalid YAML: ${msg}`);
  }
  return parseYaml(src, file);
}

function frontmatter(path) {
  const src = readFileSync(path, 'utf8');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  return strictYaml(m[1], rel(path), 2);
}


// Colour is never a signal in this company: no key that mentions colour, no hex colour values.
function findColorKeys(node, path, where) {
  if (Array.isArray(node)) node.forEach((v, k) => findColorKeys(v, `${path}[${k}]`, where));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/colou?r/i.test(k)) err(`${where}: "${path}.${k}" - colour fields are not allowed; use symbol (icon name) and words`);
      // A team's tone names a hue from a fixed set (checked with the teams), for identity, never a signal.
      if (k === 'tone' && /^\.teams\[\d+\]$/.test(path)) continue;
      findColorKeys(v, `${path}.${k}`, where);
    }
  } else if (typeof node === 'string' && (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(node.trim()) || /^(rgb|hsl)a?\(/i.test(node.trim()) || COLOUR_WORDS.has(node.trim().toLowerCase()))) {
    err(`${where}: "${path}" holds a colour value "${node}"; colours are not used as signals`);
  }
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/u;
const ICON_NAME = /^[a-z][a-z0-9_]*$/;          // Material Symbols naming
const MONOGRAM = /^[א-ת]{2}$/;          // two Hebrew letters
const COLOUR_WORDS = new Set(['red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'black', 'white', 'gray', 'grey', 'brown', 'cyan', 'magenta']);
const KINDS = ['permanent', 'project', 'task'];
const LIFECYCLES = ['always-on', 'dormant', 'ephemeral'];
const PROJECT_STATUS = ['active', 'dormant'];
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function checkSymbol(owner, sym, where) {
  if (typeof sym !== 'string' || sym.trim() === '') return err(`${where}: ${owner} has no symbol`);
  if (EMOJI.test(sym)) return err(`${where}: ${owner} symbol "${sym}" is an emoji; use a Material Symbols icon name`);
  if (!ICON_NAME.test(sym)) return err(`${where}: ${owner} symbol "${sym}" is not an icon name (lowercase, digits, underscore)`);
  if (COLOUR_WORDS.has(sym)) err(`${where}: ${owner} symbol "${sym}" is a colour, not an icon`);
}

// The Authority block: from its heading to the closing marker, matched as whole lines.
const AUTHORITY_HEADING = '# Authority — read this before you decide you are not allowed';
const AUTHORITY_END = '<!-- /RAN:AUTHORITY -->';
// sha256 of the verbatim block in ~/.claude/CLAUDE.md as copied on 20/10/2026.
// When he changes the source, copy the new text into directives.md and update this pin in the same PR.
const AUTHORITY_SHA256 = '56ec6097c8334b54d9450898aeeaa08570d6f5bd0237eb79028a4c675efc2220';

// A company set up from the starter kit has no CLAUDE.md to copy from: its Authority block is the engine's own,
// in English (like every worker instruction, 08/11/2026), describing what the hook refuses. It must equal
// starter/company/directives.md of this engine.
const GENERIC_AUTHORITY_HEADING = '# Authority: read this before you decide you are not allowed';
const DOSSIER_SECTIONS = [['## Personality', '## אישיות'], ['## Role', '## תפקיד'], ['## Authority', '## סמכות'], ['## Automations', '## אוטומציות'], ['## Escalation', '## הסלמה']];
const GENERIC_AUTHORITY_END = '<!-- /AUTHORITY -->';
const STARTER_DIRECTIVES = join(dirname(fileURLToPath(import.meta.url)), '..', 'starter', 'company', 'directives.md');

export function extractAuthority(text, heading = AUTHORITY_HEADING, endMarker = AUTHORITY_END) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const end = lines.indexOf(endMarker, start);
  if (end < 0) return null;
  return lines.slice(start, end).join('\n').trimEnd();
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

// Every relative markdown link in a file must point to something that exists.
function checkLinks(file) {
  const text = readFileSync(file, 'utf8').replace(/(```|~~~)[\s\S]*?\1/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    let target = m[1].trim().replace(/\s+"[^"]*"$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    target = target.replace(/^<(.*)>$/, '$1');
    const decoded = safeDecode(target.replace(/#.*$/, ''));
    if (decoded === null) { err(`${rel(file)}: link "${m[1]}" is not valid URL encoding`); continue; }
    target = decoded;
    if (!existsSync(join(dirname(file), target))) err(`${rel(file)}: link "${m[1]}" points to nothing`);
  }
}

// Paths a charter tells a worker to read (in merge_instructions and in the body): absolute ones into the company
// (~/company/...) or the engine (~/projects/agent-company/...), anywhere on a line, and, inside `code` or a link
// target, relative ones into skills/ (`skills/x`, `../skills/x`). After #156 five charters pointed at a skill path that did not exist and nothing
// noticed. The company's deployed paths map onto the checkout being checked (a PR worktree checks its own tree), and
// the engine's onto this engine. Other absolute paths (other machines, other repos, placeholders) are not ours to check.
const HOME_PREFIX = String.raw`(?:~|/home/[^/\s]+)`;
const PATH_ROOTS = [
  [new RegExp(`^${HOME_PREFIX}/company(?=/|$)`), () => root],
  [new RegExp(`^${HOME_PREFIX}/projects/agent-company(?=/|$)`), () => engineRoot],
];
const clean = (tok) => tok.replace(/^[('"<*\u200e\u200f]+/, '').replace(/#.*$/, '').replace(/[)\]'"<>.,;!?*…\u200e\u200f]+$/, '')
  .replace(/(:\d+(-\d+)?)+:?$|:$/, '');
const skip = (tok) => !tok || /[<>*${}]/.test(tok);
export function charterPathRefs(text) {
  const refs = [];
  text.split('\n').forEach((line, i) => {
    const add = (path) => { if (!refs.some((r) => r.line === i + 1 && r.path === path)) refs.push({ line: i + 1, path }); };
    for (const m of line.matchAll(/`([^`]+)`/g)) for (const t of m[1].split(/\s+/)) {
      const tok = clean(t);
      if (!skip(tok) && (/^(~\/|\/)/.test(tok) || /^(\.\.\/)*skills\//.test(tok))) add(tok);
    }
    // Relative link targets are checkLinks'.
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      const tok = safeDecode(m[1].replace(/^<(.*)>$/, '$1').replace(/#.*$/, ''));
      if (!skip(tok) && /^(~\/|\/)/.test(tok)) add(tok);
    }
    // Written without `code` (a plain merge_instructions step, "ב-/home/..."): the company's and the engine's paths still count.
    for (const t of line.split(/[\s`[\]()]+/)) {
      if (t.includes('://')) continue;
      const at = t.search(new RegExp(`${HOME_PREFIX}/`));
      const tok = at < 0 ? '' : clean(t.slice(at));
      if (!skip(tok) && PATH_ROOTS.some(([re]) => re.test(tok))) add(tok);
    }
  });
  return refs;
}
function checkCharterPaths(charter, companyDir) {
  for (const { line, path } of charterPathRefs(readFileSync(charter, 'utf8'))) {
    let target = null;
    if (path.startsWith('skills/')) target = join(companyDir, path);
    else if (path.startsWith('../')) target = join(dirname(charter), path);
    else for (const [re, base] of PATH_ROOTS) if (re.test(path)) { target = join(base(), path.replace(re, '')); break; }
    if (!target || existsSync(target)) continue;
    err(`${rel(charter)}:${line}: path "${path}" does not exist (looked for ${target})`);
  }
}

function listMarkdown(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (lstatSync(p).isSymbolicLink()) continue;
    if (statSync(p).isDirectory()) out.push(...listMarkdown(p));
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
}

export function main() {
  if (homeMode && !given && root === engineRoot) {
    console.log('check:contract --home: COMPANY_HOME is not set, no company to check here');
    return;
  }
  if (homeMode) console.log(`check:contract --home: ${root}`);
  const companyDir = join(root, 'company');
  const memoryDir = join(root, 'memory');

  // -------------------------------------------------------------------------
  // org.yaml
  // -------------------------------------------------------------------------
  const W = 'company/org.yaml';
  const orgPath = join(companyDir, 'org.yaml');
  let org = null;
  if (!existsSync(orgPath)) err(`${W} is missing`);
  else {
    let parsed = false;
    try { org = strictYaml(readFileSync(orgPath, 'utf8'), W); parsed = true; }
    catch (e) { err(`${W}: ${e.message}`); }
    if (!isObj(org)) { if (parsed) err(`${W}: top level must be a non-empty mapping`); org = null; }
    else if (typeof org.owner !== 'string' || !org.owner) err(`${W}: "owner" must be set (the id everyone reports to)`);
    // #121: the one time zone of the company (night, home, the hours in the app). An IANA name.
    // setup: pending = the skeleton from the starter kit, before the setup conversation (skills/setup).
    // Until then the owner's name and time zone are not known yet; the playbook fills them and drops the flag.
    if (org && org.setup != null && org.setup !== 'pending') err(`${W}: "setup" can only be "pending" (the skeleton before the setup conversation), got ${JSON.stringify(org.setup)}`);
    if (org && !(org.setup === 'pending' && org.timezone == null)) {
      let tzOk = typeof org.timezone === 'string' && !!org.timezone;
      if (tzOk) { try { new Intl.DateTimeFormat('en-US', { timeZone: org.timezone }); } catch { tzOk = false; } }
      if (!tzOk) err(`${W}: "timezone" must be an IANA time zone (e.g. Asia/Bangkok), got ${JSON.stringify(org.timezone)}`);
    }
  }

  if (org) {
    findColorKeys(org, '', W);
    const list = (key, label) => {
      if (!Array.isArray(org[key])) { err(`${W}: "${key}" must be a list`); return []; }
      return org[key].filter((x, k) => isObj(x) || (err(`${W}: ${key}[${k}] must be a mapping, got ${JSON.stringify(x)}`), false));
    };
    const teams = list('teams', 'team');
    const identities = list('identities', 'identity');
    const projects = org.projects == null ? [] : list('projects', 'project');

    const uniq = (items, label) => {
      const seen = new Set();
      for (const x of items) {
        if (typeof x.id !== 'string' || !x.id) { err(`${W}: a ${label} entry has no id`); continue; }
        if (seen.has(x.id)) err(`${W}: duplicate ${label} id "${x.id}"`);
        seen.add(x.id);
      }
      return seen;
    };
    const teamIds = uniq(teams, 'team');
    const identityIds = uniq(identities, 'identity');
    const projectIds = uniq(projects, 'project');
    for (const id of identityIds) if (teamIds.has(id)) err(`${W}: id "${id}" is used by both a team and an identity`);
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const byId = new Map(identities.map((p) => [p.id, p]));

    // The machines workers run on (home, checkouts). Without the list any name goes.
    let machines = null;
    if (org.machines != null) {
      if (!Array.isArray(org.machines) || !org.machines.length || org.machines.some((m) => typeof m !== 'string' || !m)) err(`${W}: "machines" must be a non-empty list of names`);
      else machines = org.machines;
    }
    const machineOk = (m) => typeof m === 'string' && m !== '' && (!machines || machines.includes(m));
    const machineList = machines ? `one of ${machines.join('|')}` : 'a machine name';
    // hq reads these two (packages/hq/src/config.ts): who gets escalations and who gets probe anomalies.
    for (const k of ['manager', 'monitoring_lead']) {
      if (org[k] != null && !identityIds.has(org[k])) err(`${W}: "${k}" "${org[k]}" is not an identity`);
    }
    // The names in texts (packages/shared/src/names.ts): a misspelt gender would quietly bend every text to male.
    if ((org.owner_name != null || org.setup !== 'pending') && (typeof org.owner_name !== 'string' || !org.owner_name.trim())) err(`${W}: "owner_name" must be a non-empty name`);
    const GENDERS = ['male', 'female'];
    if (org.owner_gender != null && !GENDERS.includes(org.owner_gender)) err(`${W}: "owner_gender" "${org.owner_gender}" is not one of ${GENDERS.join('|')}`);
    for (const p of org.identities ?? []) {
      if (p?.gender != null && !GENDERS.includes(p.gender)) err(`${W}: identity "${p.id}" gender "${p.gender}" is not one of ${GENDERS.join('|')}`);
    }

    for (const t of teams) {
      const who = `team "${t.id}"`;
      if (!t.name) err(`${W}: ${who} has no name`);
      if (!KINDS.includes(t.kind)) err(`${W}: ${who} kind "${t.kind}" is not one of ${KINDS.join('|')}`);
      checkSymbol(who, t.symbol, W);
      if (t.tone != null && !TONES.includes(t.tone)) err(`${W}: ${who} tone "${t.tone}" is not one of ${TONES.join('|')}`);
      if (!identityIds.has(t.lead)) err(`${W}: ${who} lead "${t.lead}" is not an identity`);
      if (t.members != null && !Array.isArray(t.members)) err(`${W}: ${who} members must be a list`);
      for (const m of Array.isArray(t.members) ? t.members : []) if (!identityIds.has(m)) err(`${W}: ${who} member "${m}" is not an identity`);
      for (const m of [t.lead, ...(Array.isArray(t.members) ? t.members : [])]) {
        const p = byId.get(m);
        if (p && p.team !== t.id) err(`${W}: ${who} lists "${m}", but that identity says team "${p.team}"`);
      }
      for (const f of ['name']) if (typeof t[f] === 'string' && EMOJI.test(t[f])) err(`${W}: ${who} ${f} contains an emoji`);
      if (t.kind === 'project' && !projectIds.has(t.project)) err(`${W}: ${who} project "${t.project}" is not in projects`);
    }

    const automationIds = new Set();
    const required = ['id', 'name', 'title', 'symbol', 'team', 'reports_to', 'kind', 'lifecycle', 'may_open', 'memory_domain', 'grants', 'automations'];
    for (const p of identities) {
      const who = `identity "${p.id}"`;
      for (const f of required) if (!(f in p)) err(`${W}: ${who} is missing "${f}"`);
      checkSymbol(who, p.symbol, W);
      for (const f of ['name', 'title']) if (typeof p[f] === 'string' && EMOJI.test(p[f])) err(`${W}: ${who} ${f} contains an emoji`);
      if (typeof p.name !== 'string' || !p.name.trim()) err(`${W}: ${who} has no name`);
      if (p.phase != null && !Number.isInteger(p.phase)) err(`${W}: ${who} phase must be a whole number`);
      if (p.home != null && !machineOk(p.home)) err(`${W}: ${who} home "${p.home}" is not ${machineList}`);
      if (p.monogram != null && !MONOGRAM.test(String(p.monogram))) err(`${W}: ${who} monogram "${p.monogram}" must be two Hebrew letters`);
      const team = teamById.get(p.team);
      if (!team) err(`${W}: ${who} team "${p.team}" does not exist`);
      else if (team.lead !== p.id && !(Array.isArray(team.members) && team.members.includes(p.id))) {
        err(`${W}: ${who} says team "${p.team}", but that team lists it neither as lead nor as member`);
      }
      if (p.reports_to !== org.owner && !identityIds.has(p.reports_to)) err(`${W}: ${who} reports_to "${p.reports_to}" is neither the owner nor an identity`);
      // The reporting chain must reach the owner, without cycles.
      const seen = new Set([p.id]);
      for (let cur = p.reports_to; cur !== org.owner; cur = byId.get(cur)?.reports_to) {
        if (!byId.has(cur)) break; // already reported above
        if (seen.has(cur)) { err(`${W}: ${who} reports_to chain loops (${[...seen, cur].join(' -> ')}) and never reaches ${org.owner}`); break; }
        seen.add(cur);
      }
      if (!KINDS.includes(p.kind)) err(`${W}: ${who} kind "${p.kind}" is not one of ${KINDS.join('|')}`);
      if (!LIFECYCLES.includes(p.lifecycle)) err(`${W}: ${who} lifecycle "${p.lifecycle}" is not one of ${LIFECYCLES.join('|')}`);
      if (!Array.isArray(p.may_open)) err(`${W}: ${who} may_open must be a list`);
      else for (const k of p.may_open) if (!KINDS.includes(k)) err(`${W}: ${who} may_open "${k}" is not a team kind`);
      if (typeof p.memory_domain !== 'string' || !p.memory_domain) err(`${W}: ${who} memory_domain is empty`);
      else if (!existsSync(join(memoryDir, p.memory_domain, 'INDEX.md'))) err(`${W}: ${who} memory_domain "${p.memory_domain}" has no memory/${p.memory_domain}/INDEX.md`);
      if (!Array.isArray(p.grants)) err(`${W}: ${who} grants must be a list`);
      else for (const g of p.grants) for (const f of ['action', 'quote', 'date']) if (!g?.[f]) err(`${W}: ${who} grant is missing "${f}" (A.7: every grant carries his quote and a date)`);
      if (!Array.isArray(p.automations)) err(`${W}: ${who} automations must be a list`);
      else for (const a of p.automations) {
        if (!isObj(a) || !a.id) { err(`${W}: ${who} has an automation without id`); continue; }
        const aw = `${who} automation "${a.id}"`;
        if (automationIds.has(a.id)) err(`${W}: duplicate automation id "${a.id}"`);
        automationIds.add(a.id);
        if (typeof a.enabled !== 'boolean') err(`${W}: ${aw} needs enabled: true|false (the on/off switch)`);
        if (!a.what) err(`${W}: ${aw} has no "what"`);
        if (!a.when) err(`${W}: ${aw} has no "when"`);
      }
      const file = join(companyDir, 'identities', `${p.id}.md`);
      if (!existsSync(file)) err(`${W}: ${who} has no file company/identities/${p.id}.md`);
      else {
        const text = readFileSync(file, 'utf8');
        if (EMOJI.test(text.split('\n')[0])) err(`company/identities/${p.id}.md: heading uses an emoji; use the icon name in the symbol line`);
        // The instructions are English (08/11/2026); a dossier still in Hebrew passes until it is translated.
        const lines = text.split('\n');
        for (const [h, he] of DOSSIER_SECTIONS) {
          if (!lines.includes(h) && !lines.includes(he)) err(`company/identities/${p.id}.md: missing section "${h}"`);
        }
      }
    }
    const identDir = join(companyDir, 'identities');
    if (existsSync(identDir)) for (const f of readdirSync(identDir)) {
      if (f.endsWith('.md') && !identityIds.has(f.slice(0, -3))) err(`company/identities/${f}: no identity "${f.slice(0, -3)}" in org.yaml`);
    }

    const charters = new Set();
    for (const pr of projects) {
      const who = `project "${pr.id}"`;
      if (!PROJECT_STATUS.includes(pr.status)) err(`${W}: ${who} status "${pr.status}" is not one of ${PROJECT_STATUS.join('|')}`);
      if (pr.team && !teamIds.has(pr.team)) err(`${W}: ${who} team "${pr.team}" does not exist`);
      if (pr.status === 'active' && !pr.team) err(`${W}: ${who} is active but has no team`);
      const charter = join(companyDir, pr.charter ?? `projects/${pr.id}.md`);
      charters.add(charter);
      if (!existsSync(charter)) { err(`${W}: ${who} charter ${rel(charter)} is missing`); continue; }
      let fm;
      try { fm = frontmatter(charter); } catch (e) { err(`${rel(charter)}: ${e.message}`); continue; }
      if (!isObj(fm)) { err(`${rel(charter)}: missing YAML frontmatter`); continue; }
      findColorKeys(fm, '', rel(charter));
      if (fm.project !== pr.id) err(`${rel(charter)}: frontmatter project "${fm.project}" does not match "${pr.id}"`);
      if (fm.status !== pr.status) err(`${rel(charter)}: status "${fm.status}" differs from org.yaml "${pr.status}"`);
      for (const f of ['deviations', 'monitoring', 'grants']) if (!Array.isArray(fm[f])) err(`${rel(charter)}: "${f}" must be a list`);
      for (const g of Array.isArray(fm.grants) ? fm.grants : []) for (const f of ['team', 'action', 'quote', 'date']) if (!g?.[f]) err(`${rel(charter)}: grant is missing "${f}"`);
      // request_access (hq access.ts): a standing approval for a resource names the verbs, and carries his quote and a date, like every grant (A.7).
      if (fm.access != null) {
        if (!Array.isArray(fm.access)) err(`${rel(charter)}: "access" must be a list`);
        else for (const g of fm.access) {
          for (const f of ['resource', 'quote', 'date']) if (!g?.[f]) err(`${rel(charter)}: access grant is missing "${f}"`);
          if (g?.resource && !/^(kube:[a-z0-9-]+|ssh:[a-z0-9-]+|hq:query)$/.test(g.resource)) err(`${rel(charter)}: access grant resource "${g.resource}" is not kube:<name>, ssh:<name> or hq:query`);
          if (g?.verbs != null && (!Array.isArray(g.verbs) || !g.verbs.length || g.verbs.some((v) => !['read', 'write', 'exec'].includes(v)))) err(`${rel(charter)}: access grant verbs must be a list of read|write|exec`);
        }
      }
      for (const d of Array.isArray(fm.deviations) ? fm.deviations : []) if (!d?.reason) err(`${rel(charter)}: every deviation needs a reason`);
      if (pr.status === 'active' && !identityIds.has(fm.ceo)) err(`${rel(charter)}: ceo "${fm.ceo}" is not an identity`);
      // B.5: where workers run. hq makes <path>/<worktree_dir>/<task> per task in the first checkout.
      if (fm.checkouts != null) {
        if (!Array.isArray(fm.checkouts)) err(`${rel(charter)}: "checkouts" must be a list`);
        else {
          if (!machineOk(fm.machine)) err(`${rel(charter)}: "checkouts" needs "machine", ${machineList}`);
          const names = new Set();
          for (const c of fm.checkouts) {
            if (!isObj(c) || [c.name, c.path, c.default_branch].some((v) => typeof v !== 'string' || !v)) { err(`${rel(charter)}: every checkout needs name, path and default_branch (strings; quote a numeric branch)`); continue; }
            if (names.has(c.name)) err(`${rel(charter)}: duplicate checkout "${c.name}"`);
            names.add(c.name);
            if (!/^(~\/|\/)/.test(c.path)) err(`${rel(charter)}: checkout "${c.name}" path must be absolute or start with ~/`);
          }
        }
      }
      if (fm.worktree_dir != null && (typeof fm.worktree_dir !== 'string' || fm.worktree_dir.startsWith('/') || fm.worktree_dir.includes('..'))) {
        err(`${rel(charter)}: "worktree_dir" must be a path inside the checkout`);
      }
      if (fm.commands != null && (!isObj(fm.commands) || Object.values(fm.commands).some((v) => typeof v !== 'string' || !v))) {
        err(`${rel(charter)}: "commands" must map names to command strings`);
      }
      if (fm.merge_instructions != null && !(typeof fm.merge_instructions === 'string' ? fm.merge_instructions
        : Array.isArray(fm.merge_instructions) && fm.merge_instructions.length && fm.merge_instructions.every((v) => typeof v === 'string' && v))) {
        err(`${rel(charter)}: "merge_instructions" must be a string or a list of strings (one per step)`);
      }
      if (fm.design_review != null) {
        const dr = fm.design_review;
        if (!isObj(dr) || !identityIds.has(dr.reviewer)) err(`${rel(charter)}: design_review needs "reviewer", an identity`);
        if (!isObj(dr) || !Array.isArray(dr.paths) || !dr.paths.length || !dr.paths.every((v) => typeof v === 'string' && v)) err(`${rel(charter)}: design_review needs "paths", a list of paths`);
        for (const k of ['wait_minutes', 'small_lines']) if (isObj(dr) && dr[k] != null && !(Number.isInteger(dr[k]) && dr[k] > 0)) err(`${rel(charter)}: design_review "${k}" must be a positive whole number`);
      }
      // live: what runs in production and how hq reads it (packages/hq/src/live.ts, task 1476). A part hq would drop is an error.
      if (fm.live != null) {
        if (!Array.isArray(fm.live)) err(`${rel(charter)}: "live" must be a list of parts`);
        const seen = new Set();
        for (const p of Array.isArray(fm.live) ? fm.live : []) {
          const name = isObj(p) && typeof p.part === 'string' && p.part ? p.part : null;
          if (!name) { err(`${rel(charter)}: every live part needs "part", a name`); continue; }
          if (seen.has(name)) err(`${rel(charter)}: live part "${name}" appears twice`);
          seen.add(name);
          if (!(typeof p.sha === 'string' && p.sha.trim())) err(`${rel(charter)}: live part "${name}" needs "sha", a command that prints the commit it runs`);
          if (p.repo != null ? !(typeof p.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(p.repo)) : !(typeof fm.repo === 'string' && fm.repo))
            err(`${rel(charter)}: live part "${name}" needs "repo" (owner/name), or the charter's repo`);
          if (p.paths != null && !(Array.isArray(p.paths) && p.paths.length && p.paths.every((v) => typeof v === 'string' && v)))
            err(`${rel(charter)}: live part "${name}" "paths" must be a list of paths`);
        }
      }
      // codex: Codex as a task worker (packages/hq/src/workspace.ts codexCharter). No `default`: a task goes to Codex only when its opener asks.
      if (fm.codex != null) {
        const cx = fm.codex;
        if (!isObj(cx) || !['off', 'on-request'].includes(cx.tasks)) err(`${rel(charter)}: codex needs "tasks": off or on-request`);
        if (isObj(cx) && cx.model != null && !(typeof cx.model === 'string' && cx.model)) err(`${rel(charter)}: codex "model" must be a model name`);
      }
      // heavy: the classes `reserve` knows in this project (packages/hq/src/heavy.ts). hq drops a class it cannot read, so a typo is caught here.
      if (fm.heavy != null) {
        if (!Array.isArray(fm.heavy)) err(`${rel(charter)}: "heavy" must be a list of classes`);
        else for (const [i, h] of fm.heavy.entries()) {
          if (!isObj(h) || typeof h.class !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(h.class)) err(`${rel(charter)}: heavy[${i}] needs "class", a lowercase name`);
          else if (!/^\s*\d+(\.\d+)?\s*(kb|mb|gb|tb|k|m|g|t)?\s*$/i.test(String(h.mem))) err(`${rel(charter)}: heavy "${h.class}" needs "mem", a size (8GB, 512MB)`);
          else if (h.cpu != null && !(typeof h.cpu === 'number' && h.cpu > 0)) err(`${rel(charter)}: heavy "${h.class}" "cpu" must be a positive number`);
          else if (h.timeout != null && !/^\s*\d+(\.\d+)?\s*[smh]?\s*$/i.test(String(h.timeout))) err(`${rel(charter)}: heavy "${h.class}" "timeout" must be a duration (30m, 90s, 2h)`);
        }
      }
      // paused: he put the project on hold. hq does not wake it when it stands with work open (stall-watch).
      if (fm.paused != null && fm.paused !== true && !(typeof fm.paused === 'string' && fm.paused.trim())) err(`${rel(charter)}: "paused" must be true or the reason (a string)`);
      checkCharterPaths(charter, companyDir);
      if (fm.ci === 'required' && !fm.ci_check) err(`${rel(charter)}: ci: required needs "ci_check" (the check name a merge waits for)`);
    }
    const projDir = join(companyDir, 'projects');
    if (existsSync(projDir)) for (const f of readdirSync(projDir)) {
      if (f.endsWith('.md') && !charters.has(join(projDir, f))) err(`company/projects/${f}: not listed under projects in org.yaml`);
    }
  }

  // -------------------------------------------------------------------------
  // directives.md: the Authority block is verbatim, ids are unique
  // -------------------------------------------------------------------------
  const directivesPath = join(companyDir, 'directives.md');
  if (!existsSync(directivesPath)) err('company/directives.md is missing');
  else {
    const d = readFileSync(directivesPath, 'utf8');
    const dLines = d.split('\n');
    if (!dLines.includes(AUTHORITY_HEADING) && dLines.includes(GENERIC_AUTHORITY_HEADING)) {
      const block = extractAuthority(d, GENERIC_AUTHORITY_HEADING, GENERIC_AUTHORITY_END);
      const engine = existsSync(STARTER_DIRECTIVES) ? extractAuthority(readFileSync(STARTER_DIRECTIVES, 'utf8'), GENERIC_AUTHORITY_HEADING, GENERIC_AUTHORITY_END) : null;
      if (block === null) err(`company/directives.md: the Authority block must run from "${GENERIC_AUTHORITY_HEADING}" to a line "${GENERIC_AUTHORITY_END}"`);
      else if (engine === null) err(`company/directives.md: cannot read the engine's Authority block from ${STARTER_DIRECTIVES}`);
      else if (block !== engine) err('company/directives.md: the Authority block differs from the engine\'s (starter/company/directives.md). It describes what the hook refuses; copy it again, word for word');
    } else if (!dLines.includes(AUTHORITY_HEADING)) err(`company/directives.md: the Authority heading is missing ("${AUTHORITY_HEADING}" or "${GENERIC_AUTHORITY_HEADING}")`);
    else {
    const block = extractAuthority(d);
    if (block === null) err(`company/directives.md: the Authority block must run from "${AUTHORITY_HEADING}" to a line "${AUTHORITY_END}"`);
    else {
      if (sha256(block) !== AUTHORITY_SHA256) err('company/directives.md: the Authority block differs from the pinned verbatim copy. Copy it again from ~/.claude/CLAUDE.md and update AUTHORITY_SHA256 in the same PR');
      const source = join(homedir(), '.claude', 'CLAUDE.md');
      if (existsSync(source)) {
        const src = extractAuthority(readFileSync(source, 'utf8'));
        const srcText = readFileSync(source, 'utf8');
        if (src === null && srcText.split(/\r?\n/).includes(AUTHORITY_HEADING)) err(`~/.claude/CLAUDE.md has the Authority heading but no "${AUTHORITY_END}" line; cannot compare`);
        if (src !== null && src !== block) err('company/directives.md: the Authority block differs from ~/.claude/CLAUDE.md on this machine. Copy it again, word for word');
      }
    }
    }
    const ids = [...d.matchAll(/^## (dir-\d{4})\b/gm)].map((m) => m[1]);
    const dup = ids.filter((x, k) => ids.indexOf(x) !== k);
    if (dup.length) err(`company/directives.md: duplicate directive ids ${[...new Set(dup)].join(', ')}`);
  }
  for (const f of ['company.md', 'modes/night.md']) if (!existsSync(join(companyDir, f))) err(`company/${f} is missing`);

  // -------------------------------------------------------------------------
  // skills
  // -------------------------------------------------------------------------
  const skillsDir = join(companyDir, 'skills');
  if (existsSync(skillsDir)) for (const s of readdirSync(skillsDir)) {
    const p = join(skillsDir, s);
    if (!statSync(p).isDirectory()) continue;
    const sk = join(p, 'SKILL.md');
    if (!existsSync(sk)) { err(`company/skills/${s}: missing SKILL.md`); continue; }
    let fm;
    try { fm = frontmatter(sk); } catch (e) { err(`${rel(sk)}: ${e.message}`); continue; }
    if (!isObj(fm)) { err(`${rel(sk)}: missing frontmatter`); continue; }
    findColorKeys(fm, '', rel(sk));
    if (fm.name !== s) err(`${rel(sk)}: name "${fm.name}" must match the folder "${s}"`);
    if (!fm.description) err(`${rel(sk)}: description is empty`);
  }

  // -------------------------------------------------------------------------
  // memory/: every folder has INDEX.md; unindexed files are warnings, so
  // parallel lanes adding files don't break CI.
  // -------------------------------------------------------------------------
  function walkMemory(dir) {
    const isRoot = dir === memoryDir;
    const indexPath = join(dir, 'INDEX.md');
    if (!isRoot && !existsSync(indexPath)) err(`${rel(dir)}: missing INDEX.md`);
    const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
    const links = [...index.matchAll(/\]\((<[^>]+>|[^)\s]+)\)/g)]
      .map((m) => safeDecode(m[1].replace(/^<(.*)>$/, '$1').replace(/#.*$/, '')))
      .filter((l) => l && !/^[a-z]+:/i.test(l));
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (lstatSync(p).isSymbolicLink()) continue;
      if (statSync(p).isDirectory()) {
        if (!isRoot && !links.some((l) => l.replace(/^\.\//, '').replace(/\/.*$/, '') === e)) warn(`${rel(indexPath)}: folder "${e}/" is not listed`);
        walkMemory(p);
      } else if (!isRoot && e.endsWith('.md') && e !== 'INDEX.md' && !links.some((l) => l.replace(/^\.\//, '') === e)) {
        warn(`${rel(indexPath)}: "${e}" is not listed in the index`);
      }
    }
  }
  if (!existsSync(memoryDir)) err('memory/ is missing');
  else {
    if (!existsSync(join(memoryDir, 'README.md'))) err('memory/README.md is missing');
    walkMemory(memoryDir);
  }

  // Links in every markdown file of the contract and the memory.
  for (const dir of [companyDir, memoryDir]) if (existsSync(dir)) for (const f of listMarkdown(dir)) checkLinks(f);

  // -------------------------------------------------------------------------
  for (const w of warnings) console.warn(`warn  ${w}`);
  for (const e of errors) console.error(`error ${e}`);
  if (errors.length) {
    console.error(`\ncheck:contract failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`check:contract ok (${warnings.length} warning(s))`);
}

// Run only when executed directly, so tests can import parseYaml.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
