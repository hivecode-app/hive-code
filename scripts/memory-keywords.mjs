#!/usr/bin/env node
// Fill the L3 keyword cache (<stateRoot>/memory/keywords.json, sha1 -> {he, en})
// for every memory record that has no keywords yet. One pinned-claude haiku
// call per batch of records. Reads the memory sources; writes only the cache.
//
//   node scripts/memory-keywords.mjs [--bet9] [--repo DIR] [--state DIR]
//        [--batch 10] [--concurrency 3] [--force] [--dry-run]
//
// Sources: --bet9 = the bet-9 corpus (owner's Claude memory dirs, `memoryImport` in
// <state>/hq.config.json); else
// <repo>/memory (--repo, COMPANY_REPO or cwd) + COMPANY_L3_EXTRA_SOURCES.
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  bet9Sources, defaultStateRoot, extraSourcesFromEnv, keywordCachePath, loadKeywordCache, loadRecords,
} from '../packages/mcp-company/src/l3.ts';

const { values: opt } = parseArgs({
  options: {
    bet9: { type: 'boolean', default: false },
    repo: { type: 'string' },
    state: { type: 'string' },
    batch: { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '3' },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const HOME = homedir();
const CLAUDE = join(HOME, '.local/share/agent-company/claude/current/claude');
const LAB = join(HOME, '.local/state/agent-company/lab/keywords');
const stateRoot = opt.state ?? defaultStateRoot();
const cachePath = keywordCachePath(stateRoot);
const sources = opt.bet9
  ? bet9Sources(stateRoot)
  : [{ dir: join(opt.repo ?? process.env.COMPANY_REPO ?? process.cwd(), 'memory') }, ...extraSourcesFromEnv()];

const cache = loadKeywordCache(stateRoot);
const records = loadRecords(sources, opt.force ? {} : cache)
  .filter((r) => opt.force || !(r.keywordsHe.length && r.keywordsEn.length));
const batchSize = Math.max(1, Number(opt.batch));
const batches = [];
for (let i = 0; i < records.length; i += batchSize) batches.push(records.slice(i, i + batchSize));
console.error(`[keywords] ${records.length} records need keywords -> ${batches.length} batches; cache ${cachePath}`);
if (opt['dry-run'] || !records.length) process.exit(0);

function prompt(batch) {
  const items = batch.map((r) => ({ id: r.id, name: r.name, description: r.description, body: r.body.slice(0, 1500) }));
  return [
    'You index memory records of a solo business owner (Ran, Hebrew speaker) for a bilingual keyword search.',
    'For EACH record below produce search keywords:',
    '- "he": 8-15 Hebrew keywords/short phrases: Hebrew translations of the key terms, synonyms, and the words',
    '  Ran would use when asking a question in Hebrew that this record answers (e.g. "ביטוח בריאות", "מרכאות").',
    '- "en": 8-15 English keywords/short phrases: key terms, synonyms, and how one would ask about it in English.',
    'Include proper nouns (products, services, banks, tools) as they are written. No sentences.',
    'Reply with ONLY strict JSON, no prose, no code fences: {"<id>": {"he": [...], "en": [...]}, ...} with every id below.',
    '',
    'RECORDS:',
    JSON.stringify(items),
  ].join('\n');
}

function runClaude(text) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--setting-sources', 'project,local',
      '--strict-mcp-config', '--permission-mode', 'bypassPermissions', '--', text];
    const child = spawn(CLAUDE, args, { cwd: LAB, env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(`claude error: ${String(res.result).slice(0, 300)}`));
        resolve(res);
      } catch { reject(new Error(`claude exit ${code}: ${(err || out).slice(0, 300)}`)); }
    });
  });
}

function extractJson(s) {
  const t = s.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return JSON.parse(t.slice(a, b + 1));
}

const clean = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 20) : []);

function saveCache() {
  mkdirSync(join(stateRoot, 'memory'), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 1) + '\n');
  renameSync(tmp, cachePath);
}

mkdirSync(LAB, { recursive: true });
const t0 = Date.now();
let cost = 0, done = 0, failed = 0, next = 0;

async function processBatch(batch, attempt = 1) {
  const started = Date.now();
  try {
    const res = await runClaude(prompt(batch));
    cost += res.total_cost_usd ?? 0;
    const kw = extractJson(String(res.result));
    for (const r of batch) {
      const k = kw[r.id];
      const he = clean(k?.he), en = clean(k?.en);
      if (!he.length || !en.length) { failed++; console.error(`[keywords] no keywords for ${r.id}`); continue; }
      cache[r.sha1] = { he, en };
      done++;
    }
    saveCache();
    console.error(`[keywords] batch of ${batch.length} ok in ${((Date.now() - started) / 1000).toFixed(1)}s, $${(res.total_cost_usd ?? 0).toFixed(4)}`);
  } catch (e) {
    if (attempt < 2) return processBatch(batch, attempt + 1);
    failed += batch.length;
    console.error(`[keywords] batch failed (${batch.map((r) => r.id).join(', ')}): ${e.message}`);
  }
}

async function worker() {
  while (next < batches.length) await processBatch(batches[next++]);
}
await Promise.all(Array.from({ length: Math.max(1, Number(opt.concurrency)) }, worker));
console.log(JSON.stringify({ records: records.length, done, failed, costUsd: Number(cost.toFixed(4)), seconds: Math.round((Date.now() - t0) / 1000), cache: cachePath }));
process.exit(failed ? 1 : 0);
