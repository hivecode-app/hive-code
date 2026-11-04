import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';

/** Copy CDN assets into the version. The runtime stays offline even if a download fails. */
export async function vendorAssets(root: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const warnings: string[] = [], assets = new Map<string, string>();
  let bytes = 0, count = 0;
  const measure = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir,name), s = statSync(path); if (s.isDirectory()) measure(path); else { bytes += s.size; count++; } } }; measure(root);

  const local = async (url: string, from: string): Promise<string> => {
    const full = new URL(url).href;
    let dest = assets.get(full);
    if (!dest) {
      if (++count > 2000) throw new Error('too many external assets');
      dest = join(root, '_vendor', createHash('sha256').update(full).digest('hex').slice(0,24));
      assets.set(full, dest); // Break cycles in CSS imports.
      const response = await fetcher(full, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      if (!response.ok || !/^https?:/.test(response.url || full)) throw new Error(`download failed (${response.status})`);
      const content: Buffer[] = [];
      if (!response.body) throw new Error('empty download');
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 50 * 1024 * 1024) throw new Error('external assets exceed 50MB');
        content.push(Buffer.from(chunk));
      }
      let data = Buffer.concat(content);
      const type = response.headers.get('content-type') ?? '';
      const extension = /css/.test(type) ? '.css' : /javascript/.test(type) ? '.js' : /woff2/.test(type) ? '.woff2' : /woff/.test(type) ? '.woff' : /font.*ttf|font.*sfnt/.test(type) ? '.ttf' : /image\/png/.test(type) ? '.png' : /image\/jpeg/.test(type) ? '.jpg' : /image\/svg/.test(type) ? '.svg' : extname(new URL(response.url || full).pathname).replace(/[^.a-z0-9]/gi, '').slice(0,12);
      dest += extension; assets.set(full,dest);
      if (/css|javascript|text\/html/.test(type)) data = Buffer.from(await rewrite(data.toString(), dest, response.url || full));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); writeFileSync(dest, data, { mode: 0o600 });
    }
    const path = relative(dirname(from), dest).split(sep).join('/');
    return path.startsWith('.') ? path : `./${path}`;
  };
  const rewrite = async (text: string, from: string, base?: string) => {
    const pattern = /(?:\b(?:src|href)\s*=\s*["']|url\(\s*["']?|@import\s+["']|\bfrom\s+["']|\bimport\s*\(?\s*["'])([^\s"')<>]+)["']?/gi;
    const matches = [...text.matchAll(pattern)];
    for (const match of matches.reverse()) {
      // A normal hyperlink stays a hyperlink. Only link elements are downloadable href assets.
      if (/^href/i.test(match[0]) && !/^<link\b/i.test(text.slice(text.lastIndexOf('<',match.index),match.index).trim())) continue;
      const value = match[1]!;
      if (/^(?:data:|blob:|#)/.test(value)) continue;
      const url = /^https?:\/\//.test(value) ? value : value.startsWith('//') ? 'https:' + value : base ? new URL(value, base).href : null;
      if (!url || !/^https?:/.test(url)) continue;
      try {
        const dest = await local(url, from);
        const start = match.index! + match[0].indexOf(value);
        text = text.slice(0,start) + dest + text.slice(start + value.length);
      } catch (err) { assets.delete(new URL(url).href); warnings.push(`${url}: ${(err as Error).message}`); }
    }
    return text;
  };
  const walk = async (dir: string): Promise<void> => {
    for (const name of readdirSync(dir)) {
      if (name === '_vendor') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) await walk(path);
      else if (['.html','.htm','.css','.js','.mjs'].includes(extname(name).toLowerCase())) writeFileSync(path, await rewrite(readFileSync(path, 'utf8'), path));
    }
  };
  await walk(root);
  return warnings;
}
