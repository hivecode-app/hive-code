// Images the owner attaches in the app. The app uploads the bytes first (POST /api/uploads), then
// sends the message with their ids (POST /api/messages/tell, `attachments`). The files live on this
// machine under <state>/uploads, the same machine the shifts run on, so the worker gets a path in its
// envelope and opens it with Read, which shows it the image itself. Owner-only, like hq.db (B.3 ⚠).
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Store } from './store.ts';

/** A phone photo is a few MB; a screenshot of a big monitor as PNG can pass 10. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface Upload { id: string; name: string; mime: string; bytes: number; path: string; created_at: number }
/** What the app gets, and what a message carries: never the path, which is for the worker. */
export type AttachmentDTO = Pick<Upload, 'id' | 'name' | 'mime' | 'bytes'>;

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

export function readRaw(req: IncomingMessage, limit = UPLOAD_MAX_BYTES): Promise<Buffer> {
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
  constructor(store: Store, stateDir: string) {
    this.store = store;
    this.dir = join(stateDir, 'uploads');
  }

  save(data: Buffer, name: string | undefined): AttachmentDTO {
    if (!data.length) throw new UploadError(400, 'empty file');
    const kind = sniffImage(data);
    if (!kind) throw new UploadError(415, 'only PNG, JPEG, GIF and WebP images');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = `u-${randomUUID()}`;
    const path = join(this.dir, `${id}.${kind.ext}`);
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
    const clean = (name ?? '').replace(/[\u0000-\u001f/\\]/g, '').trim().slice(0, 120) || `image.${kind.ext}`;
    this.store.db.prepare('INSERT INTO uploads (id, name, mime, bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, clean, kind.mime, data.length, path, this.store.now());
    return { id, name: clean, mime: kind.mime, bytes: data.length };
  }

  get(id: string): Upload | undefined {
    return this.store.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Upload | undefined;
  }

  read(id: string): { upload: Upload; data: Buffer } | null {
    const u = this.get(id);
    if (!u || !existsSync(u.path)) return null;
    return { upload: u, data: readFileSync(u.path) };
  }
}

export const toDTO = (u: Upload): AttachmentDTO => ({ id: u.id, name: u.name, mime: u.mime, bytes: u.bytes });
