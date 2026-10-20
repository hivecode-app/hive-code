#!/usr/bin/env node
// After the split (scripts/split-company.sh): a relative link in company/ or memory/ that pointed into the engine
// (../../docs/SPEC.md) points to nothing in the company's own repo. It becomes a link to the same file in the engine
// on GitHub. Links inside the company stay relative. Code spans and fences are not links (as check-contract.mjs reads them).
//   node scripts/split-links.mjs <companyRepo> <engineCheckout> <owner/engine-repo>
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function markdown(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...markdown(p));
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
}

/** One file's text with its engine links rewritten; `changed` lists [from, to]. */
export function rewriteLinks(text, file, companyRoot, engineRoot, slug) {
  const changed = [];
  // Only outside code: split on fences and inline code, rewrite the even (prose) parts.
  const parts = text.split(/((?:```|~~~)[\s\S]*?(?:```|~~~)|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, target, title) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return all;
      const [path, hash = ''] = target.split(/(?=#)/);
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { return all; }
      const abs = resolve(dirname(file), decoded);
      if (existsSync(abs)) return all;
      const inEngine = resolve(engineRoot, relative(companyRoot, abs));
      const rel = relative(engineRoot, inEngine);
      if (rel.startsWith('..') || rel.split(sep)[0] === '' || !existsSync(inEngine)) return all;
      const url = `https://github.com/${slug}/blob/main/${rel.split(sep).map(encodeURIComponent).join('/')}${hash}`;
      changed.push([target, url]);
      return `](${url}${title})`;
    });
  }
  return { text: parts.join(''), changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [companyRoot, engineRoot, slug] = process.argv.slice(2).map((a, i) => (i < 2 ? resolve(a) : a));
  if (!companyRoot || !engineRoot || !slug) { console.error('usage: split-links.mjs <companyRepo> <engineCheckout> <owner/repo>'); process.exit(2); }
  let n = 0;
  for (const f of [...markdown(join(companyRoot, 'company')), ...markdown(join(companyRoot, 'memory'))]) {
    const r = rewriteLinks(readFileSync(f, 'utf8'), f, companyRoot, engineRoot, slug);
    if (!r.changed.length) continue;
    writeFileSync(f, r.text);
    for (const [a, b] of r.changed) { console.log(`${relative(companyRoot, f)}: ${a} -> ${b}`); n++; }
  }
  console.log(`${n} links into the engine rewritten`);
}
