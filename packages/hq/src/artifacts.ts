import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';
import { workerPath } from './file-access.ts';
import { UploadError } from './uploads.ts';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { vendorAssets } from './artifact-vendor.ts';

export const ARTIFACT_TTL = 30 * 86_400_000;
export const ARTIFACT_LINK_TTL = 12 * 3_600_000;
const MAX_BYTES = 50 * 1024 * 1024, MAX_FILES = 2000;
interface Artifact { id: string; owner: string; task_id: number | null; title: string; latest: number; expires_at: number; pinned: number; expired: number; message_id: string; thumb: string | null }
interface Version { artifact: string; version: number; path: string; title: string; note: string; network: number; op_id: string; ready: number; warnings: string }
export interface ShowArgs { path?: string; html?: string; title: string; id?: string; note?: string; network?: boolean }
export interface ShowResult { id: string; version: number; url_in_app: string; url: string; warnings?: string[] }
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** App DTO: local paths, operation ids and signing keys never cross this boundary. */
export function artifactInfo(store: Store, id: string) {
  const a = store.db.prepare('SELECT id, owner, task_id, title, latest, expires_at, pinned, expired, message_id FROM artifacts WHERE id=?').get(id) as Omit<Artifact, 'thumb'> | undefined;
  if (!a) return null;
  const versions = store.db.prepare(`SELECT v.version, v.title, v.note, v.network, o.received_at AS created_at
    FROM artifact_versions v LEFT JOIN ops o ON o.id=v.op_id WHERE v.artifact=? AND v.ready=1 ORDER BY v.version DESC`).all(id) as { version:number; title:string; note:string; network:number; created_at:number|null }[];
  return { ...a, pinned: !!a.pinned, expired: !!a.expired || !a.pinned && a.expires_at <= store.now(), versions: versions.map(v => ({...v, network: !!v.network})) };
}
export type ArtifactInfo = NonNullable<ReturnType<typeof artifactInfo>>;

export class Artifacts {
  private key: Buffer;
  private store: Store;
  private stateDir: string;
  private mailbox: Mailbox;
  readonly appOrigin: string | null;
  private jobs = new Map<string, Promise<string[]>>();
  readonly dir: string;
  readonly origin: string;
  constructor(store: Store, stateDir: string, mailbox: Mailbox, appOrigin: string | null) {
    this.store = store; this.stateDir = stateDir; this.mailbox = mailbox; this.appOrigin = appOrigin;
    this.dir = join(stateDir, 'artifacts'); mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const keyPath = join(stateDir, 'artifact-key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
    const app = new URL(appOrigin ?? 'https://app.hq.example.com');
    app.hostname = app.hostname.startsWith('app.') ? app.hostname.replace(/^app\./, 'art.') : `art.${app.hostname}`;
    this.origin = app.origin;
  }
  get(id: string): Artifact | undefined { return this.store.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact | undefined; }
  version(id: string, n: number): Version | undefined { return this.store.db.prepare('SELECT * FROM artifact_versions WHERE artifact = ? AND version = ?').get(id,n) as Version | undefined; }

  stage(identity: string, args: ShowArgs, opId: string): ShowResult {
    const old = this.store.db.prepare('SELECT artifact, version FROM artifact_versions WHERE op_id = ?').get(opId) as { artifact: string; version: number } | undefined;
    if (old) return this.link(old.artifact, old.version);
    if (typeof args.title !== 'string' || (args.path != null && typeof args.path !== 'string') || (args.html != null && typeof args.html !== 'string') || (args.id != null && typeof args.id !== 'string') || (args.note != null && typeof args.note !== 'string') || (args.network != null && typeof args.network !== 'boolean') || !args.title.trim() || (!!args.path === (args.html != null))) throw new UploadError(400, 'pass title and exactly one of path or html');
    const existing = args.id ? this.get(args.id) : undefined;
    if (args.id && !existing) throw new UploadError(404, 'no such artifact');
    const task = this.store.db.prepare("SELECT id FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1").get(identity) as { id: number } | undefined;
    if (existing && existing.owner !== identity && (!task || task.id !== existing.task_id)) throw new UploadError(403, 'only the creator or task successor may update an artifact');
    const id = existing?.id ?? `a-${createHash('sha256').update(opId).digest('hex').slice(0,32)}`;
    const version = ((this.store.db.prepare('SELECT MAX(version) AS n FROM artifact_versions WHERE artifact=?').get(id) as {n:number|null}).n ?? 0) + 1;
    const path = join(this.dir, id, `v${version}`);
    if (existsSync(path)) rmSync(path, { recursive: true });
    mkdirSync(path, { recursive: true, mode: 0o700 });
    let bytes = 0, count = 0;
    const write = (to: string, data: Buffer) => {
      bytes += data.length;
      if (bytes > MAX_BYTES || ++count > MAX_FILES) throw new UploadError(413, 'artifact exceeds 50MB or 2000 files');
      mkdirSync(resolve(to, '..'), { recursive: true, mode: 0o700 }); writeFileSync(to, data, { mode: 0o600 });
    };
    const copy = (from: string, to: string, root: string) => {
      if (lstatSync(from).isSymbolicLink()) throw new UploadError(403, 'artifact symlinks are refused');
      const real = workerPath(this.store, this.stateDir, identity, from);
      if (real !== root && !real.startsWith(root + sep)) throw new UploadError(403, 'artifact symlink leaves its root');
      if (statSync(real).isDirectory()) for (const name of readdirSync(real)) copy(join(real,name), join(to,name), root);
      else {
        if (statSync(real).size + bytes > MAX_BYTES) throw new UploadError(413, 'artifact exceeds 50MB');
        write(to, readFileSync(real));
      }
    };
    try {
      if (args.html != null) write(join(path,'index.html'), Buffer.from(args.html));
      else {
        const source = workerPath(this.store, this.stateDir, identity, args.path!);
        if (statSync(source).isDirectory()) {
          copy(source, path, source);
          if (!existsSync(join(path,'index.html'))) throw new UploadError(400, 'artifact directory needs index.html');
        } else {
          const ext = extname(source).toLowerCase();
          if (['.html','.htm'].includes(ext)) write(join(path,'index.html'), readFileSync(source));
          else if (ext === '.md' || ext === '.csv') {
            const text = readFileSync(source,'utf8');
            for (const font of ['Heebo-400.ttf','Heebo-700.ttf','OFL.txt']) write(join(path,font),readFileSync(fileURLToPath(new URL(`../../app/assets/fonts/${font}`,import.meta.url))));
            // Escape content; CSV sorting is local to the artifact and needs no external library.
            const content = ext === '.md' ? `<pre dir="auto">${escape(text)}</pre>` : `<table id="data">${csvRows(text).map((r) => '<tr>' + r.map((c) => `<td dir="auto">${escape(c)}</td>`).join('') + '</tr>').join('')}</table><script>document.querySelectorAll('tr:first-child td').forEach((c,i)=>c.onclick=()=>{let t=c.closest('table');[...t.rows].slice(1).sort((a,b)=>a.cells[i].textContent.localeCompare(b.cells[i].textContent,undefined,{numeric:true})).forEach(r=>t.append(r))})</script>`;
            write(join(path,'index.html'), Buffer.from(`<!doctype html><meta charset="utf-8"><title>${escape(args.title)}</title><style>@font-face{font-family:Heebo;src:url(Heebo-400.ttf);font-weight:400}@font-face{font-family:Heebo;src:url(Heebo-700.ttf);font-weight:700}body{font:16px/1.6 Heebo,sans-serif;padding:24px;background:#f7f7f5;color:#242423}pre{font:inherit;white-space:pre-wrap;max-width:78ch}td{padding:8px;border-bottom:1px solid #ddd;white-space:pre-wrap}tr:first-child{cursor:pointer;font-weight:700}@media(prefers-color-scheme:dark){body{background:#1c1c1b;color:#eee}td{border-color:#444}}</style>${content}`));
          } else if (['.svg','.png','.pdf'].includes(ext)) {
            write(join(path,`file${ext}`),readFileSync(source));
            write(join(path,'index.html'), Buffer.from(`<!doctype html><meta charset="utf-8"><title>${escape(args.title)}</title>${ext === '.pdf' ? `<object type="application/pdf" data="file.pdf" width="100%" height="100%"><a href="file.pdf">PDF</a></object>` : `<img style="max-width:100%" src="file${ext}">`}`));
          } else throw new UploadError(400, 'show supports HTML, Markdown, CSV, SVG, PNG or PDF');
        }
      }
    } catch (err) { rmSync(path, { recursive: true, force: true }); throw err; }
    const expires = this.store.now() + ARTIFACT_TTL;
    this.store.db.prepare(`INSERT INTO artifacts (id,owner,task_id,title,latest,expires_at,message_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO NOTHING`).run(id, identity, task?.id ?? null, args.title.trim().slice(0,200), 0, expires, `artifact-${id}`);
    this.store.db.prepare('INSERT INTO artifact_versions (artifact,version,path,title,note,network,op_id) VALUES (?,?,?,?,?,?,?)').run(id, version, path, args.title.trim().slice(0,200), args.note ?? '', args.network === true ? 1 : 0, opId);
    return this.link(id,version);
  }

  async finish(id: string, version: number): Promise<string[]> {
    const key = `${id}/${version}`, existing = this.jobs.get(key); if (existing) return existing;
    const job = this.prepare(id,version).finally(() => this.jobs.delete(key)); this.jobs.set(key,job); return job;
  }
  private async prepare(id: string, version: number): Promise<string[]> {
    const a = this.get(id)!, v = this.version(id,version)!;
    let warnings = JSON.parse(v.warnings) as string[];
    if (!v.ready) {
      warnings = v.network ? [] : await vendorAssets(v.path);
      this.assertBounds(v.path);
      const candidate = ['file.png','file.svg'].map((f) => join(v.path,f)).find((p) => existsSync(p));
      const generic = Buffer.from('<svg width="512" height="320" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="320" fill="#f7f7f5"/><rect x="50" y="40" width="412" height="240" rx="6" fill="white" stroke="#999"/><path d="M80 95h350M80 130h210M80 165h280M80 200h170" stroke="#999" stroke-width="8"/></svg>');
      const thumb = join(this.dir,id,'thumb.jpg');
      const previewOf = (input:string|Buffer) => sharp(input,{limitInputPixels:100_000_000}).resize(512,512,{fit:'inside',withoutEnlargement:true}).jpeg({quality:55}).toBuffer();
      let preview:Buffer;
      try {preview=await previewOf(candidate ?? generic);}
      catch(err) {warnings.push(`preview unavailable: ${(err as Error).message}`);preview=await previewOf(generic);}
      // Only a successful preparation may publish a version. An older concurrent job cannot rewind it.
      if (this.get(id)!.latest < version) {
        writeFileSync(thumb,preview,{mode:0o600});
        this.store.db.prepare('UPDATE artifacts SET title=?, latest=?, expires_at=?, expired=0, thumb=? WHERE id=?').run(v.title,version,this.store.now()+ARTIFACT_TTL,thumb,id);
      }
      this.store.db.prepare('UPDATE artifact_versions SET ready=1, warnings=? WHERE artifact=? AND version=?').run(JSON.stringify(warnings),id,version);
    }
    const url = this.open(id,version).url;
    const body = `${v.title}\n${url}\n${v.network ? 'פונה לרשת' : 'בקשות חיצוניות חסומות; קישורים וניווט עשויים לצאת לרשת'} · נשמר ל-30 יום`;
    const message = this.mailbox.get(a.message_id);
    if (!message) this.mailbox.tell({ msg_id: a.message_id, from: a.owner, to: 'owner', body, ref: a.task_id ? `task-${a.task_id}` : undefined });
    else if (this.get(id)!.latest === version && message.body !== body) {
      this.store.db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(body,a.message_id);
      this.store.emit('message.updated', 'owner', this.mailbox.get(a.message_id)!);
    }
    if (version > 1) this.mailbox.tell({ msg_id: `${a.message_id}-v${version}`, from: a.owner, to: 'owner', kind: 'system', body: `עודכנה גרסה ${version}${v.note ? ': ' + v.note : ''}`, ref: a.message_id });
    return warnings;
  }
  private assertBounds(dir: string): void {
    let bytes = 0, files = 0;
    const walk = (p: string) => { for (const f of readdirSync(p)) { const path=join(p,f), s=statSync(path); if(s.isDirectory()) walk(path); else { bytes+=s.size; files++; } } }; walk(dir);
    if (bytes > MAX_BYTES || files > MAX_FILES) throw new UploadError(413,'artifact exceeds 50MB or 2000 files');
  }
  open(id: string, version?: number): ShowResult {
    const a = this.get(id); if (!a) throw new UploadError(404,'no such artifact');
    if (a.expired || (!a.pinned && a.expires_at <= this.store.now())) throw new UploadError(410,'artifact expired');
    const n = version ?? a.latest;
    const v=this.version(id,n);
    if (!v) throw new UploadError(404,'no such artifact version');
    if (!v.ready) throw new UploadError(409,'artifact version not ready');
    if (!existsSync(join(v.path,'index.html'))) throw new UploadError(410,'artifact content removed');
    return this.link(id,n);
  }
  private link(id:string,n:number): ShowResult {
    const expires = this.store.now() + ARTIFACT_LINK_TTL;
    const signature = createHmac('sha256',this.key).update(`${id}/${n}/${expires}`).digest('base64url');
    return { id, version: n, url_in_app: `/artifact/${id}?version=${n}`, url: `${this.origin}/artifacts/${id}/v${n}/${expires}-${signature}/index.html` };
  }
  content(id: string, version: number, token: string, file: string) {
    const split = token.indexOf('-'), expires = Number(token.slice(0,split));
    const sig = token.slice(split+1), expected = createHmac('sha256',this.key).update(`${id}/${version}/${expires}`).digest('base64url');
    const supplied=Buffer.from(sig), wanted=Buffer.from(expected);
    if (!Number.isFinite(expires) || expires <= this.store.now() || supplied.length !== wanted.length || !timingSafeEqual(supplied,wanted)) throw new UploadError(403,'invalid artifact token');
    const a=this.get(id), v=this.version(id,version);
    if (!a || !v || a.expired || (!a.pinned && a.expires_at <= this.store.now())) throw new UploadError(410,'artifact expired');
    if (!v.ready) throw new UploadError(409,'artifact version not ready');
    const path = resolve(v.path,file);
    if (!path.startsWith(v.path + sep) || !existsSync(path) || !statSync(path).isFile() || !realpathSync(path).startsWith(v.path+sep)) throw new UploadError(404,'no such artifact file');
    return { path, mime: artifactMime(path), headers: this.headers(!!v.network) };
  }
  headers(network: boolean): Record<string,string> {
    const app = this.appOrigin ? new URL(this.appOrigin).origin : 'https://app.hq.example.com';
    return { 'content-security-policy': `default-src 'self' 'unsafe-inline' data: blob:${network ? ' https:' : ''}; form-action 'none'; base-uri 'none'; frame-ancestors ${app}; sandbox allow-scripts`,
      'access-control-allow-origin': '*', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-dns-prefetch-control': 'off', 'cache-control': 'no-store' };
  }
  keep(id: string, pinned: boolean): void { const a=this.get(id); if (!a) throw new UploadError(404,'no such artifact'); if(pinned && (a.expired || !a.pinned && a.expires_at<=this.store.now())) throw new UploadError(410,'artifact expired'); this.store.db.prepare('UPDATE artifacts SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0,id); this.store.emit('artifact.updated','owner',{artifact:artifactInfo(this.store,id)}); }
  sweep(): void {
    const rows = this.store.db.prepare('SELECT * FROM artifacts WHERE pinned=0 AND expired=0 AND expires_at<=?').all(this.store.now()) as Artifact[];
    for (const a of rows) {
      if ([...this.jobs.keys()].some(key=>key.startsWith(a.id+'/'))) continue;
      const versions = this.store.db.prepare('SELECT path FROM artifact_versions WHERE artifact=?').all(a.id) as { path: string }[];
      for (const v of versions) rmSync(v.path,{recursive:true,force:true});
      this.store.db.prepare('UPDATE artifacts SET expired=1 WHERE id=?').run(a.id);
      this.store.emit('artifact.expired','owner',{id:a.id});
    }
  }
  async drain(): Promise<void> { await Promise.allSettled(this.jobs.values()); }
}
export function artifactMime(path: string): string {
  return ({ '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.pdf':'application/pdf', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf' } as Record<string,string>)[extname(path)] ?? 'application/octet-stream';
}

/** CSV quoting is interpreted before escaping each cell for HTML. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new UploadError(400, 'unclosed CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
