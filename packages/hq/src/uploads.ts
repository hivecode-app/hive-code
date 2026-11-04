// Images the owner attaches in the app. The app uploads the bytes first (POST /api/uploads), then
// sends the message with their ids (POST /api/messages/tell, `attachments`). The files live on this
// machine under <state>/uploads, the same machine the shifts run on, so the worker gets a path in its
// envelope and opens it with Read, which shows it the image itself. Owner-only, like hq.db (B.3 ⚠).
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open as openFile, readFile, rename } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { prepareMedia, type UploadMeta } from './upload-media.ts';
import { workerPath } from './file-access.ts';
import type { DictateConfig } from './dictate.ts';
import type { Store } from './store.ts';

/** A phone photo is a few MB; a screenshot of a big monitor as PNG can pass 10. */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const UPLOAD_DIRECT_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_MS = 24 * 3_600_000;
export const UPLOAD_PENDING_MAX_BYTES = 20 * UPLOAD_MAX_BYTES;
export const UPLOAD_MAX_SESSIONS = 100;
export interface Upload { id: string; name: string; mime: string; bytes: number; path: string; created_at: number; meta?: UploadMeta | null }
/** What the app gets, and what a message carries: never the path, which is for the worker. */
export type AttachmentDTO = Pick<Upload, 'id' | 'name' | 'mime' | 'bytes' | 'meta'>;

export class UploadError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The formats a worker can see (Read shows these as images). Decided by the bytes, never by the header. */
export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

export function readRaw(req: IncomingMessage, limit = UPLOAD_DIRECT_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) { req.resume(); return reject(new UploadError(413, 'file too large')); }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { req.removeAllListeners('data'); req.resume(); reject(new UploadError(413, 'file too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class Uploads {
  private store: Store;
  readonly dir: string;
  private jobs = new Map<string, Promise<void>>();
  private dictate?: DictateConfig;
  private running = 0;
  private waiting: (() => void)[] = [];
  private imports = new Set<Promise<string[]>>();
  private completing = new Map<string, Promise<AttachmentDTO>>();
  constructor(store: Store, stateDir: string, dictate?: DictateConfig) {
    this.store = store; this.dictate = dictate;
    this.dir = join(stateDir, 'uploads');
    this.sweep(true);
  }

  save(data: Buffer, name: string | undefined): AttachmentDTO {
    if (!data.length) throw new UploadError(400, 'empty file');
    if (data.length > UPLOAD_MAX_BYTES) throw new UploadError(413, 'file too large');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = `u-${randomUUID()}`;
    const kind = sniffFile(data, name);
    const path = join(this.dir, `${id}.${kind.ext}`);
    writeFileSync(path, data, { mode: 0o600 });
    let result: AttachmentDTO;
    try { result = this.record(id, path, name, kind.mime, data.length); }
    catch (err) { rmSync(path,{force:true}); throw err; }
    this.store.bg(this.prepare(id), 'upload.prepare');
    return result;
  }

  private record(id: string, path: string, name: string | undefined, mime: string, bytes: number): AttachmentDTO {
    const clean = (name ?? '').replace(/[\u0000-\u001f/\\]/g, '').trim().slice(0, 200) || basename(path);
    this.store.db.prepare('INSERT INTO uploads (id, name, mime, bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, clean, mime, bytes, path, this.store.now());
    return { id, name: clean, mime, bytes };
  }

  get(id: string): Upload | undefined {
    const row = this.store.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as (Omit<Upload, 'meta'> & { meta: string | null }) | undefined;
    return row && { ...row, meta: row.meta ? JSON.parse(row.meta) as UploadMeta : null };
  }

  prepare(id: string): Promise<void> {
    if(this.get(id)?.meta) return Promise.resolve();
    const active = this.jobs.get(id); if (active) return active;
    const job = this.queued(() => this.derive(id)).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job); return job;
  }
  private async queued(work: () => Promise<void>): Promise<void> {
    if (this.running < 2) this.running++; else await new Promise<void>(r=>this.waiting.push(r));
    try { await work(); } finally { const next=this.waiting.shift(); if(next) next(); else this.running--; }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.imports,...this.completing.values()]); await Promise.allSettled(this.jobs.values()); }
  private async derive(id: string): Promise<void> {
    const u = this.get(id);
    if (!u || u.meta) return;
    const {detected_mime,...meta} = await prepareMedia(u, this.dictate);
    this.store.db.prepare('UPDATE uploads SET meta = ?, mime = COALESCE(?,mime) WHERE id = ?').run(JSON.stringify(meta),detected_mime??null,id);
    this.store.emit('upload.ready', null, { upload: toDTO(this.get(id)!) });
  }

  open(name: string, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > UPLOAD_MAX_BYTES) throw new UploadError(400, 'size must be between 1 and 200MB');
    this.sweep();
    const pending = this.store.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM upload_sessions WHERE upload_id IS NULL').get() as {count:number;bytes:number};
    if(pending.count >= UPLOAD_MAX_SESSIONS || pending.bytes + bytes > UPLOAD_PENDING_MAX_BYTES) throw new UploadError(429,'too many unfinished uploads; finish or wait for expiration');
    const id = `up-${randomUUID()}`;
    this.store.db.prepare('INSERT INTO upload_sessions (id,name,bytes,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, name.slice(0,200), bytes, this.store.now(), this.store.now());
    try { mkdirSync(join(this.dir, id), { recursive: true, mode: 0o700 }); } catch (err) { this.store.db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id); throw err; }
    return this.status(id);
  }

  status(id: string) {
    const s = this.store.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id) as { id: string; name: string; bytes: number; upload_id: string | null } | undefined;
    if (!s) throw new UploadError(404, 'no such upload session');
    const parts = (this.store.db.prepare('SELECT part FROM upload_parts WHERE session = ? ORDER BY part').all(id) as { part: number }[]).map((p) => p.part);
    return { ...s, parts, part_bytes: UPLOAD_PART_BYTES, upload: s.upload_id ? toDTO(this.get(s.upload_id)!) : null };
  }

  part(id: string, n: number, data: Buffer) {
    const s = this.status(id);
    if(this.completing.has(id)) throw new UploadError(409,'completion is in progress');
    if (s.upload_id) throw new UploadError(409, 'upload already complete');
    const count = Math.ceil(s.bytes / UPLOAD_PART_BYTES);
    if (!Number.isInteger(n) || n < 0 || n >= count) throw new UploadError(400, 'invalid part number (zero based)');
    const size = Math.min(UPLOAD_PART_BYTES, s.bytes - n * UPLOAD_PART_BYTES);
    if (data.length !== size) throw new UploadError(400, 'incorrect part size');
    const hash = createHash('sha256').update(data).digest('hex');
    const tmp = join(this.dir, id, `${n}.${randomUUID()}.tmp`);
    try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, join(this.dir, id, `${n}.part`));
    this.store.db.prepare('INSERT INTO upload_parts (session,part,sha256) VALUES (?,?,?) ON CONFLICT(session,part) DO UPDATE SET sha256=excluded.sha256').run(id, n, hash);
    this.store.db.prepare('UPDATE upload_sessions SET updated_at=? WHERE id=?').run(this.store.now(),id);
    } catch(err) { rmSync(tmp,{force:true}); throw err; }
    return this.status(id);
  }

  complete(id: string, expectedSha256?: string): Promise<AttachmentDTO> {
    const active=this.completing.get(id);if(active)return active;
    const job=this.assemble(id,expectedSha256).finally(()=>this.completing.delete(id));this.completing.set(id,job);return job;
  }
  private async assemble(id: string, expectedSha256?: string): Promise<AttachmentDTO> {
    const session=this.status(id);
    if(session.upload){await this.prepare(session.upload.id);return toDTO(this.get(session.upload.id)!);}
    if(session.parts.length!==Math.ceil(session.bytes/UPLOAD_PART_BYTES))throw new UploadError(409,'upload has missing parts');
    const uid=`u-${randomUUID()}`,tmp=join(this.dir,`${uid}.tmp`),hash=createHash('sha256');
    let first:Buffer=Buffer.alloc(0),path:string|undefined;
    try {
      const handle=await openFile(tmp,'wx',0o600);
      try {
        for(const n of session.parts){
          const b=await readFile(join(this.dir,id,`${n}.part`));if(!first.length)first=b.subarray(0,8192);hash.update(b);
          for(let at=0;at<b.length;){const wrote=await handle.write(b,at,b.length-at);at+=wrote.bytesWritten;}
        }
      }finally{await handle.close();}
      if(expectedSha256&&hash.digest('hex')!==expectedSha256.toLowerCase())throw new UploadError(400,'sha256 mismatch');
      const kind=sniffFile(first,session.name);path=join(this.dir,`${uid}.${kind.ext}`);await rename(tmp,path);
      this.store.db.transaction(()=>{this.record(uid,path!,session.name,kind.mime,session.bytes);this.store.db.prepare('UPDATE upload_sessions SET upload_id=?,updated_at=? WHERE id=?').run(uid,this.store.now(),id);})();
    }catch(err){rmSync(tmp,{force:true});if(path)rmSync(path,{force:true});throw err;}
    rmSync(join(this.dir,id),{recursive:true,force:true});await this.prepare(uid);return toDTO(this.get(uid)!);
  }

  importFiles(identity: string, files: string[], ref?: string): Promise<string[]> {
    const job=this.copyFiles(identity,files,ref).finally(()=>this.imports.delete(job));this.imports.add(job);return job;
  }
  private async copyFiles(identity: string, files: string[], ref?: string): Promise<string[]> {
    if(files.length>20)throw new UploadError(400,'at most 20 files per message');
    const paths=files.map(p=>workerPath(this.store,join(this.dir,'..'),identity,p,ref));
    for(const p of paths)if(!statSync(p).isFile()||statSync(p).size>UPLOAD_MAX_BYTES)throw new UploadError(400,'file must be regular and at most 200MB');
    mkdirSync(this.dir,{recursive:true,mode:0o700});const ids:string[]=[];
    try {
      for(const source of paths){
        const id=`u-${randomUUID()}`,tmp=join(this.dir,`${id}.tmp`);let first:Buffer=Buffer.alloc(0),bytes=0,path:string|undefined;
        try {
          const input=await openFile(source,constants.O_RDONLY|constants.O_NOFOLLOW);
          try {
            workerPath(this.store,join(this.dir,'..'),identity,`/proc/self/fd/${input.fd}`,ref);
            await pipeline(input.createReadStream({autoClose:false}),new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(!first.length)first=chunk.subarray(0,8192);done(bytes>UPLOAD_MAX_BYTES?new UploadError(413,'file too large'):null,chunk);}}),createWriteStream(tmp,{flags:'wx',mode:0o600})); } finally { await input.close(); }
          const kind=sniffFile(first,basename(source));path=join(this.dir,`${id}.${kind.ext}`);await rename(tmp,path);this.record(id,path,basename(source),kind.mime,bytes);ids.push(id);
        }catch(err){rmSync(tmp,{force:true});if(path)rmSync(path,{force:true});throw err;}
      }
      await Promise.all(ids.map(id=>this.prepare(id)));return ids;
    }catch(err){await this.discard(ids);throw err;}
  }
  async discard(ids:string[]):Promise<void>{
    await Promise.allSettled(ids.map(id=>this.jobs.get(id)));
    for(const id of ids){const u=this.get(id);if(!u)continue;rmSync(u.path,{force:true});rmSync(`${u.path}.d`,{recursive:true,force:true});this.store.db.prepare('DELETE FROM uploads WHERE id=?').run(id);}
  }
  sweep(startup=false):void{
    const expired=this.store.db.prepare('SELECT id FROM upload_sessions WHERE updated_at<=?').all(this.store.now()-UPLOAD_SESSION_TTL_MS) as {id:string}[];
    for(const {id} of expired){if(this.completing.has(id))continue;rmSync(join(this.dir,id),{recursive:true,force:true});this.store.db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id);}
    if(!existsSync(this.dir))return;
    for(const name of readdirSync(this.dir)){
      const path=join(this.dir,name);
      if(/^u-[0-9a-f-]{36}\.tmp$/.test(name)&&(startup||statSync(path).mtimeMs<this.store.now()-UPLOAD_SESSION_TTL_MS))rmSync(path,{force:true});
      const match=/^(u-[0-9a-f-]{36})\.[a-z0-9]{1,12}(?:\.d)?$/.exec(name);
      if(startup&&match&&!this.get(match[1]!))rmSync(path,{recursive:true,force:true});
    }
  }

  description(id: string): string {
    const u = this.get(id);
    if (!u) return '[קובץ מצורף: הקובץ לא נמצא בשרת]';
    const meta = u.meta;
    const details = [u.name, u.mime, `${(u.bytes / 1024 / 1024).toFixed(1)}MB`, u.path];
    if (meta?.pages) details.push(`${meta.pages} עמודים`);
    if (meta?.sheets) details.push(`${meta.sheets} גיליונות`);
    if (meta?.duration) details.push(`${meta.duration} שניות`);
    if (meta?.files) details.push(`${meta.files} קבצים`);
    if (meta?.readable?.length) details.push(`גרסה קריאה: ${meta.readable.join(', ')}`);
    if (meta?.error) details.push(`הכנת תצוגה נכשלה: ${meta.error}`);
    details.push(u.mime.startsWith('image/') ? 'פותחים ב-Read' : u.mime === 'application/pdf' ? 'קוראים ב-Read עם pages' : 'קוראים ב-Read או Bash');
    return `[קובץ מצורף: ${details.join(' · ')}]`;
  }

  read(id: string): { upload: Upload; data: Buffer } | null {
    const u = this.get(id);
    if (!u || !existsSync(u.path)) return null;
    return { upload: u, data: readFileSync(u.path) };
  }
}

export const toDTO = (u: Upload): AttachmentDTO => ({ id: u.id, name: u.name, mime: u.mime, bytes: u.bytes, ...(u.meta ? { meta: publicMeta(u.meta) } : {}) });

function publicMeta(meta: UploadMeta): UploadMeta {
  const { readable, thumb, ...details } = meta;
  return details;
}

export function sniffFile(b: Buffer, name = ''): { mime: string; ext: string } {
  const image = sniffImage(b); if (image) return image;
  const ext = extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'bin';
  if (b.subarray(0, 5).toString() === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b) {
    const office: Record<string, string> = { docx: 'wordprocessingml.document', xlsx: 'spreadsheetml.sheet', pptx: 'presentationml.presentation' };
    return { mime: office[ext] ? `application/vnd.openxmlformats-officedocument.${office[ext]}` : ext === 'odt' ? 'application/vnd.oasis.opendocument.text' : 'application/zip', ext: office[ext] || ext === 'odt' ? ext : 'zip' };
  }
  if (b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp') return { mime: 'video/mp4', ext: 'mp4' };
  if (b.subarray(0,3).toString() === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (b.subarray(0,4).toString() === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (b.length > 262 && b.subarray(257,262).toString() === 'ustar') return { mime: 'application/x-tar', ext: 'tar' };
  if (b[0] === 0x1f && b[1] === 0x8b) return { mime: 'application/gzip', ext: 'gz' };
  if (['txt','md','csv'].includes(ext) && !b.includes(0)) return { mime: ext === 'csv' ? 'text/csv' : 'text/plain', ext };
  return { mime: 'application/octet-stream', ext };
}
