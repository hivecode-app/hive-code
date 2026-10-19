// L3 memory index: bilingual BM25F over memory records (B.3). Pure, local,
// no LLM at query time. The he/en bridge is the keywords field: frontmatter
// keywords_he / keywords_en, else the sidecar cache <stateRoot>/memory/keywords.json
// (sha1 of the file content -> {he, en}), filled by scripts/memory-keywords.mjs.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

export interface L3Source {
  /** Fixed domain for every record in dir; omit for a repo memory/ tree
   *  (company/x.md -> company, projects/<p>/x.md -> <p>, personal/<d>/x.md -> personal). */
  domain?: string;
  dir: string;
}

export interface L3Record {
  id: string;            // <domain>/<file without .md>
  domain: string;
  scope: string;         // company | project:<p> | personal[:<d>]
  name: string;
  description: string;
  body: string;
  sha1: string;
  keywordsHe: string[];
  keywordsEn: string[];
  path: string;
}

export interface Keywords { he: string[]; en: string[] }
export type KeywordCache = Record<string, Keywords>;

export interface L3Hit { record: L3Record; score: number }
export interface SearchOptions { project?: string; limit?: number; scope?: string }
export interface Prime { topRecord: string; index: string; ids: string[] }

export const TOP_RECORD_BUDGET = 1800;
export const INDEX_BUDGET = 1000;
export const EXTRA_SOURCES_ENV = 'COMPANY_L3_EXTRA_SOURCES';
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 256 * 1024;
const PROJECT_BOOST = 1.3;
const K1 = 1.2;
// field -> [weight, b]
const FIELDS = { kw: [3, 0.3], name: [2, 0.5], desc: [2, 0.5], body: [1, 0.75] } as const;
type Field = keyof typeof FIELDS;

const STOP = new Set(`the a an and or of to in on for is are was were what how why when who which do does did can i you
we he she it its this that these those with from by at be been as not no my me your his her our their there here if then
so than into about up out any all also just only via per vs etc
מה איך למה מתי מי של על את עם זה זו זאת יש אין הוא היא הם הן אני אתה את אנחנו לי לו לה להם כל גם אם או אבל רק עוד
כמה איפה האם צריך מותר אפשר לפני אחרי שלו שלי שלה שלנו רן ran 2026 כן לא אל עד כדי כי אז ה ו ב ל מ ש כ`.split(/\s+/));

const HE_PREFIX1 = new Set('הובלמשכ');
const HE_PREFIX2 = new Set(['וה', 'שה', 'מה', 'לה', 'בה', 'כה', 'וב', 'ול', 'ומ', 'וש', 'וכ', 'כש', 'שב', 'של', 'שמ', 'מש']);
const HEB = /^[א-ת]+$/;

/** Lowercased word tokens (Hebrew + Latin + digits), niqqud dropped, stopwords removed. */
export function tokenize(text: string): string[] {
  const clean = text.toLowerCase().replace(/[֑-ׇ]/g, '');
  const out: string[] = [];
  for (const m of clean.matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** The token plus its prefix-stripped (Hebrew) or plural-stripped (English) forms. */
export function variants(tok: string): string[] {
  const v = [tok];
  if (HEB.test(tok)) {
    if (tok.length >= 4 && HE_PREFIX1.has(tok[0]!)) v.push(tok.slice(1));
    if (tok.length >= 5 && HE_PREFIX2.has(tok.slice(0, 2))) v.push(tok.slice(2));
  } else if (/^[a-z]{4,}$/.test(tok)) {
    if (tok.endsWith('ies')) v.push(tok.slice(0, -3) + 'y');
    else if (tok.endsWith('s') && !tok.endsWith('ss')) v.push(tok.slice(0, -1));
  }
  return v;
}

// ---------- loading ----------

function listMd(dir: string): string[] {
  let ents: import('node:fs').Dirent[];
  try { ents = readdirSync(dir, { recursive: true, withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of ents) {
    // isFile() is false for symlinks: they are not followed.
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'MEMORY.md' || e.name === 'INDEX.md' || e.name === 'README.md') continue;
    out.push(join(e.parentPath, e.name));
    if (out.length >= MAX_FILES) break;
  }
  return out.sort();
}

function domainFromPath(rel: string): { domain: string; scope: string } {
  const parts = rel.split('/');
  if (parts.length >= 3 && (parts[0] === 'projects' || parts[0] === 'project')) return { domain: parts[1]!, scope: `project:${parts[1]}` };
  if (parts.length >= 3 && parts[0] === 'personal') return { domain: 'personal', scope: `personal:${parts[1]}` };
  if (parts.length >= 2 && parts[0] !== 'company') return { domain: parts[0]!, scope: parts[0]! };
  return { domain: 'company', scope: 'company' };
}

/** `project` matches project:*, `project:s` matches only project:s (not project:lumo). */
export function scopeMatches(scope: string, want: string): boolean {
  return scope === want || scope.startsWith(want + ':');
}

function scopeOfDomain(domain: string): string {
  return domain === 'company' || domain === 'personal' || domain.includes(':') ? domain : `project:${domain}`;
}

function listValue(v: string, block: string[]): string[] {
  const s = v.trim();
  const items = s ? (s.startsWith('[') ? s.replace(/^\[|\]$/g, '').split(',') : s.split(',')) : block;
  return items.map((x) => x.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

export interface ParsedMd { name: string; description: string; body: string; keywordsHe: string[]; keywordsEn: string[] }

export function parseMd(raw: string, fallbackName: string): ParsedMd {
  const res: ParsedMd = { name: fallbackName, description: '', body: raw.trim(), keywordsHe: [], keywordsEn: [] };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) {
    // repo memory/ files have no frontmatter: title = first heading (memory/README.md)
    const h = /^#\s+(.+)$/m.exec(raw);
    if (h) res.name = h[1]!.trim();
    return res;
  }
  res.body = m[2]!.trim();
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const [, key, val] = kv;
    const block: string[] = [];
    while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1]!)) block.push(lines[++i]!.replace(/^\s+-\s+/, ''));
    const v = val!.trim();
    const str = v.startsWith('"') ? v.slice(1, v.endsWith('"') ? -1 : undefined).replace(/\\"/g, '"') : v.replace(/^'|'$/g, '');
    if (key === 'name' && str) res.name = str;
    else if (key === 'description') res.description = str;
    else if (key === 'keywords_he') res.keywordsHe = listValue(val!, block);
    else if (key === 'keywords_en') res.keywordsEn = listValue(val!, block);
  }
  return res;
}

export function sha1(buf: Buffer | string): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** Records from every source, deduped by content sha1 and then by id (first wins). */
export function loadRecords(sources: readonly L3Source[], keywords: KeywordCache = {}): L3Record[] {
  const seen = new Set<string>();
  const out: L3Record[] = [];
  for (const src of sources) {
    for (const path of listMd(src.dir)) {
      let buf: Buffer;
      try {
        if (statSync(path).size > MAX_FILE_BYTES) continue;
        buf = readFileSync(path);
      } catch { continue; }
      const h = sha1(buf);
      const file = basename(path, '.md');
      const where = src.domain !== undefined
        ? { domain: src.domain, scope: scopeOfDomain(src.domain) }
        : domainFromPath(relative(src.dir, path).split(sep).join('/'));
      // repo records: id = path under memory/ (no collisions between personal/<d>/ dirs);
      // flat extra sources (bet 9 corpus): <domain>/<file>
      const id = src.domain !== undefined ? `${where.domain}/${file}` : relative(src.dir, path).split(sep).join('/').replace(/\.md$/, '');
      if (seen.has(h) || seen.has(id)) continue;
      seen.add(h); seen.add(id);
      const p = parseMd(buf.toString('utf8'), file);
      const kw = keywords[h];
      out.push({
        id, domain: where.domain, scope: where.scope, name: p.name, description: p.description, body: p.body, sha1: h,
        keywordsHe: p.keywordsHe.length ? p.keywordsHe : (kw?.he ?? []),
        keywordsEn: p.keywordsEn.length ? p.keywordsEn : (kw?.en ?? []),
        path,
      });
    }
  }
  return out;
}

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPANY_STATE_DIR || join(homedir(), '.local/state/agent-company');
}

export function keywordCachePath(stateRoot: string): string {
  return join(stateRoot, 'memory', 'keywords.json');
}

export function loadKeywordCache(stateRoot: string): KeywordCache {
  try {
    const v = JSON.parse(readFileSync(keywordCachePath(stateRoot), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as KeywordCache : {};
  } catch { return {}; }
}

/** COMPANY_L3_EXTRA_SOURCES: [{domain, dir}] or {domain: dir | dir[]}. Bad JSON -> none. */
export function extraSourcesFromEnv(env: NodeJS.ProcessEnv = process.env): L3Source[] {
  const raw = env[EXTRA_SOURCES_ENV];
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      return v.filter((s): s is L3Source => !!s && typeof s.dir === 'string' && typeof s.domain === 'string');
    }
    if (v && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).flatMap(([domain, d]) =>
        (Array.isArray(d) ? d : [d]).filter((x): x is string => typeof x === 'string').map((dir) => ({ domain, dir })));
    }
  } catch { /* ignore */ }
  return [];
}

// ---------- index ----------

interface DocStats { tf: Record<Field, Map<string, number>>; len: Record<Field, number> }

function fieldTf(text: string): { tf: Map<string, number>; len: number } {
  const tf = new Map<string, number>();
  const toks = tokenize(text);
  for (const t of toks) for (const v of variants(t)) tf.set(v, (tf.get(v) ?? 0) + 1);
  return { tf, len: toks.length };
}

export interface L3Index {
  records: readonly L3Record[];
  get(idOrName: string): L3Record | undefined;
  search(queries: readonly string[], opts?: SearchOptions): L3Hit[];
  selectForPrime(wakeText: string, project?: string): Prime;
}

export function createIndex(records: readonly L3Record[]): L3Index {
  const docs: DocStats[] = records.map((r) => {
    const parts: Record<Field, string> = {
      kw: [...r.keywordsHe, ...r.keywordsEn].join(' '),
      name: `${r.name} ${basename(r.id)}`,
      desc: r.description,
      body: r.body,
    };
    const tf = {} as Record<Field, Map<string, number>>;
    const len = {} as Record<Field, number>;
    for (const f of Object.keys(FIELDS) as Field[]) ({ tf: tf[f], len: len[f] } = fieldTf(parts[f]));
    return { tf, len };
  });
  const n = docs.length;
  const avg = {} as Record<Field, number>;
  for (const f of Object.keys(FIELDS) as Field[]) avg[f] = Math.max(1, docs.reduce((a, d) => a + d.len[f], 0) / Math.max(1, n));
  const df = new Map<string, number>();
  for (const d of docs) {
    const terms = new Set<string>();
    for (const f of Object.keys(FIELDS) as Field[]) for (const t of d.tf[f].keys()) terms.add(t);
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string) => { const x = df.get(t) ?? 0; return x ? Math.log(1 + (n - x + 0.5) / (x + 0.5)) : 0; };

  function termScore(i: number, t: string): number {
    const d = docs[i]!;
    let w = 0;
    for (const f of Object.keys(FIELDS) as Field[]) {
      const tf = d.tf[f].get(t);
      if (!tf) continue;
      const [wf, b] = FIELDS[f];
      w += wf * tf / (1 - b + b * d.len[f] / avg[f]);
    }
    return w ? idf(t) * w * (K1 + 1) / (w + K1) : 0;
  }

  function queryScores(q: string): Float64Array {
    const scores = new Float64Array(n);
    for (const tok of new Set(tokenize(q))) {
      const vs = variants(tok);
      for (let i = 0; i < n; i++) {
        let best = 0;
        for (const v of vs) best = Math.max(best, termScore(i, v) * (v === tok ? 1 : 0.85));
        scores[i] += best;
      }
    }
    return scores;
  }

  const byId = new Map(records.map((r) => [r.id, r]));

  function search(queries: readonly string[], opts: SearchOptions = {}): L3Hit[] {
    const total = new Float64Array(n);
    for (const q of queries) {
      const s = queryScores(q);
      for (let i = 0; i < n; i++) total[i] += s[i]!;
    }
    const hits: L3Hit[] = [];
    for (let i = 0; i < n; i++) {
      const r = records[i]!;
      if (!total[i] || (opts.scope && !scopeMatches(r.scope, opts.scope))) continue;
      hits.push({ record: r, score: total[i]! * (opts.project && r.domain === opts.project ? PROJECT_BOOST : 1) });
    }
    hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
    return hits.slice(0, opts.limit ?? 20);
  }

  function selectForPrime(wakeText: string, project?: string): Prime {
    const hits = search([wakeText], { ...(project ? { project } : {}), limit: 20 });
    const top = hits[0]?.record;
    const topRecord = top ? renderFull(top, TOP_RECORD_BUDGET) : '';
    const rest = [...hits.slice(1).map((h) => h.record), ...records.filter((r) => project && r.domain === project)];
    const ids = top ? [top.id] : [];
    const lines: string[] = [];
    let used = 0;
    for (const r of rest) {
      if (ids.includes(r.id)) continue;
      const ln = `- [${r.id}] ${(r.description || r.name).slice(0, 140)}`;
      if (used + ln.length + 1 > INDEX_BUDGET) break;
      lines.push(ln); ids.push(r.id); used += ln.length + 1;
    }
    return { topRecord, index: lines.join('\n'), ids };
  }

  return {
    records,
    get: (q) => byId.get(q) ?? records.find((r) => r.id.endsWith(`/${q}`)),
    search,
    selectForPrime,
  };
}

/** `### id: name`, description, body; cut to budget chars. */
export function renderFull(r: L3Record, budget = TOP_RECORD_BUDGET): string {
  return `### ${r.id}: ${r.name}\n${r.description}\n\n${r.body}`.slice(0, budget);
}

export function renderSnippet(r: L3Record, budget = 300): string {
  return (r.description ? `${r.description}\n${r.body}` : r.body).slice(0, budget);
}

/** The bet-9 corpus (spikes/bet9-memory/l3.py SOURCES): the owner's Claude memory dirs. Read-only. */
export function bet9Sources(home = homedir()): L3Source[] {
  const p = `${home}/.claude/projects`;
  return [
    { domain: 'personal', dir: `${home}/.claude/memory-shared` },
    { domain: 'personal', dir: `${p}/-home-ran-projects/memory` },
    { domain: 'lumo', dir: `${p}/-home-ran-new-lumo-application/memory` },
    { domain: 'voice-bot', dir: `${p}/-home-ran-projects-voice-bot/memory` },
    { domain: 'easy', dir: `${p}/-home-ran-projects-tiki-bot-go/memory` },
  ];
}

export interface OpenOptions { repo?: string; stateRoot?: string; extraSources?: L3Source[]; env?: NodeJS.ProcessEnv }

/** Repo memory/** + extra sources (passed, else COMPANY_L3_EXTRA_SOURCES) + the keyword cache. */
const INDEX_CACHE = new Map<string, { at: number; idx: L3Index }>();
const INDEX_TTL_MS = 30_000;

/** Builds (or reuses for 30s) the index; recall no longer rescans every call. */
export function openL3(opts: OpenOptions = {}): L3Index {
  const env = opts.env ?? process.env;
  const sources: L3Source[] = [];
  if (opts.repo) sources.push({ dir: join(opts.repo, 'memory') });
  sources.push(...(opts.extraSources ?? extraSourcesFromEnv(env)));
  const stateRoot = opts.stateRoot ?? defaultStateRoot(env);
  let kwMtime = 0;
  try { kwMtime = statSync(keywordCachePath(stateRoot)).mtimeMs; } catch { /* no cache */ }
  const key = JSON.stringify([sources, stateRoot, kwMtime]);
  const hit = INDEX_CACHE.get(key);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.idx;
  const idx = createIndex(loadRecords(sources, loadKeywordCache(stateRoot)));
  for (const [k, v] of INDEX_CACHE) if (Date.now() - v.at >= INDEX_TTL_MS) INDEX_CACHE.delete(k);
  if (INDEX_CACHE.size > 8) INDEX_CACHE.clear();
  INDEX_CACHE.set(key, { at: Date.now(), idx });
  return idx;
}
