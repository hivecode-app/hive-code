#!/usr/bin/env node
// The main /etc/caddy/Caddyfile belongs to the whole server (desk, dictate, calltr, k8s…), not to
// agent-company. Our part of it is one line, `import sites/*.caddy`, and no site block of ours.
// This takes the live main Caddyfile on stdin and prints it back with exactly that: any top-level
// block for a host of deploy/caddy/agent-company.caddy (with the comment lines right above it) is
// removed, and the import line is added once at the end. Everything else stays byte for byte.
//
//   node scripts/caddy-main.mjs < /etc/caddy/Caddyfile > candidate     (scripts/deploy.sh caddy)
//   node scripts/caddy-main.mjs --check < /etc/caddy/Caddyfile         (drift-check: exit 1 + reason)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const IMPORT_LINE = 'import sites/*.caddy';

/** Net `{` minus `}` on a line, ignoring quoted text and a `#` comment (Caddy: `#` after whitespace). */
function braces(line) {
  let n = 0, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === '`') { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (c === '{') n++;
    else if (c === '}') n--;
  }
  return n;
}

/** A site address as a bare host: `https://a.example.com:443` and `a.example.com` are the same site. */
const host = (a) => a.replace(/^https?:\/\//i, '').replace(/:443$/, '').replace(/\/.*$/, '').toLowerCase();

/** Top-level blocks: { start, end (inclusive), addresses } (addresses normalized by host()). */
export function blocks(text) {
  const lines = text.split('\n');
  const out = [];
  let depth = 0, cur = null;
  lines.forEach((line, i) => {
    const before = depth;
    depth += braces(line);
    if (before === 0 && depth > 0) {
      const head = line.slice(0, line.lastIndexOf('{')).trim();
      cur = { start: i, addresses: head ? head.split(/[\s,]+/).filter(Boolean).map(host) : [] };
    }
    if (before > 0 && depth === 0 && cur) { out.push({ ...cur, end: i }); cur = null; }
  });
  if (depth !== 0) throw new Error('unbalanced braces in the Caddyfile');
  return out;
}

/** The hosts agent-company serves: the site addresses of deploy/caddy/agent-company.caddy. */
export function companyHosts(siteText) {
  return new Set(blocks(siteText).flatMap((b) => b.addresses));
}

/** The main Caddyfile with no company block and one import line. */
export function rewrite(mainText, hosts) {
  const lines = mainText.split('\n');
  const drop = new Set();
  for (const b of blocks(mainText)) {
    if (!b.addresses.some((a) => hosts.has(a))) continue;
    // A block shared with another project's host is not ours to remove; a person has to split it.
    const other = b.addresses.filter((a) => !hosts.has(a));
    if (other.length) throw new Error(`a block serves both agent-company and ${other.join(', ')} (line ${b.start + 1}): split it by hand first`);
    for (let i = b.start; i <= b.end; i++) drop.add(i);
    for (let i = b.start - 1; i >= 0 && /^\s*#/.test(lines[i]); i--) drop.add(i);
    if (lines[b.end + 1]?.trim() === '') drop.add(b.end + 1);
  }
  const kept = lines.filter((l, i) => !drop.has(i) && l.trim() !== IMPORT_LINE).join('\n').replace(/\s+$/, '');
  return `${kept}\n\n${IMPORT_LINE}\n`;
}

/** Why the live main Caddyfile is not what rewrite() would make, or null. */
export function check(mainText, hosts) {
  const why = [];
  const ours = blocks(mainText).filter((b) => b.addresses.some((a) => hosts.has(a)));
  if (ours.length) why.push(`site blocks of agent-company in the main Caddyfile: ${ours.flatMap((b) => b.addresses).join(', ')}`);
  const imports = mainText.split('\n').filter((l) => l.trim() === IMPORT_LINE).length;
  if (imports !== 1) why.push(`"${IMPORT_LINE}" appears ${imports} times (expected once)`);
  return why.length ? why.join('; ') : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const hosts = companyHosts(readFileSync(join(repo, 'deploy/caddy/agent-company.caddy'), 'utf8'));
  const main = readFileSync(0, 'utf8');
  if (process.argv.includes('--check')) {
    const why = check(main, hosts);
    if (why) { console.log(why); process.exit(1); }
  } else {
    process.stdout.write(rewrite(main, hosts));
  }
}
