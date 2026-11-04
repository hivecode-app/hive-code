import { artifactInfo } from './artifacts.ts';
import type { Store } from './store.ts';
import { type Uploads, toDTO } from './uploads.ts';

export type FileKind = 'images' | 'documents' | 'audio' | 'apps' | 'other';
export function fileKind(mime: string): FileKind {
  if (/^(image|video)\//.test(mime)) return 'images';
  if (mime.startsWith('audio/')) return 'audio';
  if (/pdf|officedocument|opendocument|text\//.test(mime)) return 'documents';
  return 'other';
}

/** Only owner conversations. Task membership is the shift active when the message was written. */
export function listFiles(store: Store, uploads: Uploads, filters: { chat?: string; task?: number; kind?: string; offset?: number } = {}) {
  const rows = store.db.prepare(`SELECT m.id AS message, m.from_identity AS sender, m.created_at, m.body AS caption,
    CASE WHEN m.from_identity = 'owner' THEN m.to_identity ELSE m.from_identity END AS chat,
    (SELECT s.task_id FROM shifts s WHERE s.identity = CASE WHEN m.from_identity = 'owner' THEN m.to_identity ELSE m.from_identity END
      AND s.started_at <= m.created_at AND (s.ended_at IS NULL OR s.ended_at >= m.created_at)
      ORDER BY s.started_at DESC LIMIT 1) AS task,
    json_extract(a.value, '$.id') AS upload
    FROM messages m, json_each(m.attachments) a
    WHERE (m.from_identity = 'owner' OR m.to_identity = 'owner')
      AND m.attachments IS NOT NULL
      ${filters.chat ? `AND (CASE WHEN m.from_identity = 'owner' THEN m.to_identity ELSE m.from_identity END) = @chat` : ''}
    ORDER BY m.created_at DESC, m.id DESC, a.key`).all(filters.chat ? { chat: filters.chat } : {}) as { message: string; sender: string; created_at: number; chat: string; task: number | null; upload: string; caption: string }[];
  const files = [];
  for (const row of rows) {
    if (filters.kind === 'apps') continue;
    if (filters.task != null && row.task !== filters.task) continue;
    const upload = uploads.get(row.upload);
    if (!upload || filters.kind && fileKind(upload.mime) !== filters.kind) continue;
    files.push({ ...toDTO(upload), message: row.message, sender: row.sender, caption: row.caption.slice(0,240), created_at: row.created_at, chat: row.chat, task: row.task, kind: fileKind(upload.mime) });
  }
  if (!filters.kind || filters.kind === 'apps') {
    const artifacts = store.db.prepare(`SELECT a.id, a.owner, a.task_id, m.created_at, a.message_id FROM artifacts a JOIN messages m ON m.id=a.message_id ORDER BY m.created_at DESC`).all() as {id:string; owner:string; task_id:number|null; created_at:number; message_id:string}[];
    for (const a of artifacts) {
      if (filters.chat && a.owner !== filters.chat || filters.task != null && a.task_id !== filters.task) continue;
      const info = artifactInfo(store,a.id)!;
      files.push({id:a.id,name:info.title,mime:'application/x-company-artifact',bytes:0,message:a.message_id,sender:a.owner,created_at:a.created_at,chat:a.owner,task:a.task_id,kind:'apps' as const,artifact:info});
    }
  }
  files.sort((a,b) => b.created_at-a.created_at || b.message.localeCompare(a.message));
  const offset = filters.offset ?? 0;
  return { files: files.slice(offset, offset + 200), total: files.length, next: files.length > offset + 200 ? offset + 200 : null };
}
